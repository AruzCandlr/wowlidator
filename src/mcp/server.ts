#!/usr/bin/env node
/**
 * MCP control surface, spoken over stdio.
 *
 * Exposes the runner to internal developer tooling and to Claude: trigger a
 * flow, read back a structured proof bundle, and inspect or invalidate the
 * healed-selector cache without touching the filesystem directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { CacheManager } from '../cache/cache-manager.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { LlmFactory } from '../providers/llm-factory.js';
import { LlmHealerModel, JitHealer } from '../healer/jit-healer.js';
import { DEFAULT_MUTATION_POLICY, MUTATION_POLICIES, LlmGeneratorModel, TestGenerator } from '../generator/test-generator.js';
import { LlmAgentModel, WorkflowAgent } from '../orchestrator/workflow-agent.js';
import { DATA_KINDS } from '../data/mock-data.js';
import { LlmDataModel } from '../data/data-model.js';
import { LlmFlowRepairModel } from '../repair/flow-repair-model.js';
import { FlowRepairLoop } from '../repair/flow-repair-loop.js';
import { resolveReportPath, slugify, writeHtmlReport } from '../reporter/html-reporter.js';
import { writeProofBundle, type ProofBundle } from '../engine/proof-bundle.js';
import {
  runFlow,
  withPage,
  type Flow,
  type ScreenshotMode,
  type VideoMode,
} from '../engine/runner.js';
import { ContextEngine } from '../context/context-engine.js';
import { summarize as summarizeContext, toPromptContext } from '../context/query.js';

export const SERVER_NAME = 'wowlidator';
export const SERVER_VERSION = '0.2.0';
export const DEFAULT_PROOF_DIR = '.wowlidator/proofs';
export const DEFAULT_REPORT_DIR = '.wowlidator/reports';

const sel = z.string();
const intent = z.string().optional();

const flowStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string() }),
  z.object({ action: z.literal('click'), selector: sel, intent }),
  z.object({ action: z.literal('fill'), selector: sel, value: z.string(), intent }),
  z.object({ action: z.literal('selectOption'), selector: sel, value: z.string(), intent }),
  z.object({ action: z.literal('check'), selector: sel, intent }),
  z.object({ action: z.literal('uncheck'), selector: sel, intent }),
  z.object({ action: z.literal('type'), selector: sel, value: z.string(), intent }),
  z.object({ action: z.literal('waitFor'), selector: sel, intent }),
  z.object({
    action: z.literal('workflow'),
    goal: z.string().describe('Goal for the multi-page agent, e.g. "reach the plan detail page".'),
  }),
  // Composition and control flow. `use` splices in another flow file (a role
  // switch, a login) and `when` chooses a branch on what the page currently
  // shows — the two things a linear step list cannot express.
  z.object({
    action: z.literal('use'),
    flow: z.string().describe('Path to a .flow.json, relative to the flow using it.'),
    with: z
      .record(z.string(), z.string())
      .optional()
      .describe('Values for {{name}} placeholders inside the fragment.'),
    intent,
  }),
  z.object({
    action: z.literal('when'),
    visible: sel.optional(),
    hidden: sel.optional(),
    enabled: sel.optional(),
    disabled: sel.optional(),
    // Deliberately not recursive. A self-referencing zod schema turns into a
    // $ref in the emitted JSON Schema, which not every MCP client resolves;
    // an unknown action inside a branch fails loudly in the runner's dispatch
    // switch anyway, so the check is delayed rather than lost.
    then: z
      .array(z.any())
      .describe('Steps to run when the condition holds. Same shape as `steps`.'),
    else: z.array(z.any()).optional().describe('Steps to run when it does not.'),
    intent,
  }),
  // History and scrolling. `back` is what turns a list page into a journey —
  // open a card, check it, come back, open the next — without re-navigating and
  // losing the state the journey was testing.
  z.object({ action: z.literal('back'), intent }),
  z.object({ action: z.literal('forward'), intent }),
  z.object({ action: z.literal('scrollTo'), selector: sel, intent }),
  z.object({
    action: z.literal('expectScrollable'),
    selector: sel.optional().describe('Container to check. Omit for the page itself.'),
    intent,
  }),
  z.object({ action: z.literal('expectNotScrollable'), selector: sel.optional(), intent }),
  // State seeding, for preconditions such as authentication.
  z.object({ action: z.literal('setLocalStorage'), key: z.string(), value: z.string() }),
  z.object({ action: z.literal('clearStorage') }),
  z.object({
    action: z.literal('setClock'),
    time: z
      .string()
      .describe(
        'ISO date or date-time to pin the page clock to. Put it in setup, before the first goto.',
      ),
    intent,
  }),
  // Assertions.
  z.object({
    action: z.literal('expectText'),
    selector: sel,
    value: z.string(),
    anyOf: z
      .array(z.string())
      .optional()
      .describe(
        'Accepted equivalent renderings of the same content — e.g. the Thai and Latin ' +
          'forms of one name on a bilingual page. Omit to enforce the one rendering in "value".',
      ),
    intent,
  }),
  z.object({ action: z.literal('expectVisible'), selector: sel, intent }),
  z.object({ action: z.literal('expectHidden'), selector: sel, intent }),
  z.object({ action: z.literal('expectEnabled'), selector: sel, intent }),
  z.object({ action: z.literal('expectDisabled'), selector: sel, intent }),
  z.object({ action: z.literal('expectCount'), selector: sel, count: z.number().int().min(0), intent }),
  z.object({ action: z.literal('expectUrl'), value: z.string(), intent }),
  z.object({ action: z.literal('expectValue'), selector: sel, value: z.string(), intent }),
  z.object({
    action: z.literal('expectAttribute'),
    selector: sel,
    name: z.string(),
    value: z.string(),
    intent,
  }),
  // Backend. A `request` sent from a flow with UI steps inherits the session
  // those steps established, so no separate auth path is needed.
  z.object({
    action: z.literal('request'),
    method: z.string().describe('GET, POST, PUT, PATCH, DELETE, …'),
    url: z.string().describe('Absolute, or relative to the flow baseUrl. May contain {{vars}}.'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z
      .unknown()
      .optional()
      .describe('An object is JSON-encoded; a string is sent verbatim. May contain {{vars}}.'),
    save: z
      .record(z.string(), z.string())
      .optional()
      .describe('{ orderId: "$.data.id" } — saves a response value for later {{orderId}} use.'),
    timeoutMs: z.number().int().positive().optional(),
    intent,
  }),
  z.object({
    action: z.literal('expectStatus'),
    status: z
      .union([z.number().int(), z.array(z.number().int()).min(1)])
      .describe('One acceptable status, or several.'),
    intent,
  }),
  z.object({
    action: z.literal('expectJson'),
    path: z.string().describe('$.a.b[0] against the last response body.'),
    value: z.string().optional().describe('Omit to assert only that the path exists.'),
    intent,
  }),
  z.object({ action: z.literal('expectHeader'), name: z.string(), value: z.string(), intent }),
  // Keyboard / accessibility.
  z.object({ action: z.literal('press'), key: z.string(), selector: sel.optional(), intent }),
  z.object({ action: z.literal('expectFocused'), selector: sel, intent }),
  z.object({ action: z.literal('expectTabOrder'), selectors: z.array(sel).min(1), intent }),
  // Boundary-value analysis.
  z.object({
    action: z.literal('fillEach'),
    selector: sel,
    cases: z
      .array(
        z.object({
          value: z.string(),
          label: z.string().optional(),
          expectText: z.object({ selector: sel, value: z.string() }).optional(),
          expectVisible: sel.optional(),
          expectHidden: sel.optional(),
        }),
      )
      .min(1),
    submit: sel.optional().describe('Clicked after each fill, for on-submit validation.'),
    intent,
  }),
  // Mock data: regenerate-and-retry on a data conflict.
  z.object({
    action: z.literal('fillRetry'),
    selector: sel,
    kind: z
      .enum(DATA_KINDS)
      .describe(
        "'email' | 'username' | 'name' | 'phone' | 'text' generate deterministically, no model " +
          "call. 'custom' escalates to the data role — give a 'description' too.",
      ),
    failureSelector: sel.describe('Visible while the current value still conflicts.'),
    submit: sel.optional().describe('Clicked after each fill, before checking failureSelector.'),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    description: z.string().optional().describe('Field description, for the custom kind.'),
    intent,
  }),
  // Modals — dialogs/popups, detected by role="dialog"/"alertdialog" or a native <dialog open>.
  z.object({
    action: z.literal('expectModal'),
    name: z.string().optional().describe('Substring the open dialog should mention.'),
    intent,
  }),
  z.object({
    action: z.literal('closeModal'),
    button: sel.optional().describe('Selector scoped to the dialog. Omit to auto-match a Close/Accept/Dismiss button.'),
    intent,
  }),
  // Visual regression.
  z.object({ action: z.literal('snapshot'), name: z.string(), selector: sel.optional() }),
  // Sequence assertion over the page's observed traffic. This is an MCP
  // *input* schema, so the structured form is fine here (the flat string form
  // exists only for model *output* — see `flow-author.ts`).
  z.object({
    action: z.literal('expectCalls'),
    calls: z
      .array(
        z.object({
          method: z.string(),
          url: z.string().describe('Path template — /api/orders/:id and /api/orders/{id} both work.'),
          status: z
            .union([z.number().int(), z.enum(['2xx', '3xx', '4xx', '5xx'])])
            .optional()
            .describe('Exact status or class. Omitted means "completed, any status".'),
        }),
      )
      .optional()
      .describe('Ordered subsequence the window must contain; other traffic interleaves freely.'),
    never: z
      .array(z.object({ method: z.string(), url: z.string() }))
      .optional()
      .describe('Templates no observed call may match.'),
    since: z
      .enum(['mark', 'run'])
      .optional()
      .describe('"mark" (default): since the previous expectCalls settled. "run": the whole buffer.'),
    timeoutMs: z.number().int().min(1).optional(),
    intent,
  }),
  // Database verification — read-only, schema-grounded; see `src/db/`.
  z.object({
    action: z.literal('dbSnapshot'),
    tables: z.array(z.string()).min(1),
    as: z.string().optional().describe('Snapshot name later deltas refer to. Default "before".'),
    intent,
  }),
  z.object({
    action: z.literal('expectDbRow'),
    table: z.string(),
    where: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .describe('Column → value. Prefer a {{variable}} the run saved — that ties the row to this run.'),
    values: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
    count: z
      .union([z.number().int().min(0), z.string()])
      .optional()
      .describe(
        'Exact matching-row count; omitted means "at least one". A string interpolates ' +
          '{{variables}} first — how an API-reported number is compared to the database.',
      ),
    timeoutMs: z.number().int().min(1).optional(),
    intent,
  }),
  z.object({
    action: z.literal('expectDbDelta'),
    table: z.string(),
    delta: z.number().int(),
    since: z.string().optional(),
    timeoutMs: z.number().int().min(1).optional(),
    intent,
  }),
  z.object({
    action: z.literal('expectDbUnchanged'),
    tables: z.array(z.string()).min(1),
    since: z.string().optional(),
    intent,
  }),
  z.object({
    action: z.literal('expectDbCalled'),
    match: z.string().describe('Case-insensitive substring of the normalized statement.'),
    since: z.string().optional(),
    delta: z.number().int().min(0).optional(),
    atLeast: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1).optional(),
    intent,
  }),
]);

export interface ServerConfig {
  cdpUrl: string;
  cachePath: string;
  proofDir: string;
  reportDir: string;
  /** When false, failed selectors are reported instead of repaired. */
  healing: boolean;
  /** When false, `workflow` steps fail instead of invoking the agent. */
  agent: boolean;
  /** Unset means "follow the recording" — see `WowlidatorConfig.screenshots`. */
  screenshots: ScreenshotMode | undefined;
  video: VideoMode;
  /** Default report destination; a request can override it per call. */
  reportPath: string | undefined;
  reportEnabled: boolean;
  /** Shared factory so all three roles resolve from one validated config. */
  factory: LlmFactory;
}

/**
 * All env parsing lives in `src/config.ts`; this just projects it into the
 * shape the server uses and resolves paths to absolute.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const config = loadConfig(env);
  return {
    cdpUrl: config.cdpUrl,
    cachePath: resolve(config.cachePath),
    proofDir: resolve(config.proofDir),
    reportDir: resolve(config.reportDir),
    reportPath: config.reportPath,
    reportEnabled: config.reportEnabled,
    healing: config.healing,
    agent: config.agentEnabled,
    screenshots: config.screenshots,
    video: config.video,
    factory: new LlmFactory(config),
  };
}

function json(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): {
  content: [{ type: 'text'; text: string }];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createServer(config: ServerConfig = configFromEnv()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'run_flow',
    {
      title: 'Run a UI flow',
      description:
        'Execute a declarative UI flow against the browser attached over CDP and return the ' +
        'proof bundle. Selectors that fail the fast path are repaired just-in-time and the ' +
        'repair is cached for future runs.',
      inputSchema: {
        name: z.string().describe('Human-readable name for this run.'),
        baseUrl: z.string().optional().describe('Prefix for relative goto urls.'),
        steps: z.array(flowStepSchema).min(1).describe('Ordered steps to execute.'),
        setup: z
          .array(flowStepSchema)
          .optional()
          .describe('Preconditions run before steps; a failure here aborts the flow.'),
        teardown: z
          .array(flowStepSchema)
          .optional()
          .describe('Cleanup, always run — including after a failure.'),
        persist: z
          .boolean()
          .optional()
          .describe('Write the proof bundle and HTML report to disk (default true).'),
        reportPath: z
          .string()
          .optional()
          .describe(
            'Where to write the HTML report: a file path, a directory, or a template ' +
              'using {runId} {name} {status} {date} {timestamp}. Defaults to the ' +
              'server-configured report directory.',
          ),
      },
    },
    async ({ name, baseUrl, steps, setup, teardown, persist, reportPath: requestedReport }) => {
      const flow: Flow = { name, baseUrl, steps, setup, teardown };

      const bundle = await runFlow(flow, {
        cdpUrl: config.cdpUrl,
        cachePath: config.cachePath,
        screenshots: config.screenshots,
        video: config.video,
        makeHealer: config.healing
          ? (cache) =>
              new JitHealer({ model: new LlmHealerModel({ factory: config.factory }), cache })
          : undefined,
        healer: config.healing ? undefined : null,
        agent: config.agent
          ? new WorkflowAgent({ model: new LlmAgentModel({ factory: config.factory }) })
          : null,
        // Lazy like every other role: a flow with no `fillRetry(kind: 'custom')` step never
        // resolves the `data` role or demands its key.
        dataModel: new LlmDataModel({ factory: config.factory }),
      });

      let proofPath: string | null = null;
      let reportPath: string | null = null;
      if (persist !== false) {
        proofPath = await writeProofBundle(bundle, config.proofDir);
        const target = resolveReportPath(
          {
            path: requestedReport ?? config.reportPath,
            dir: config.reportDir,
            enabled: config.reportEnabled,
            defaultFilename: `${bundle.runId}.html`,
          },
          { runId: bundle.runId, name: bundle.name, status: bundle.status },
        );
        reportPath = target === null ? null : await writeHtmlReport(bundle, target);
      }

      // Screenshots are megabytes of base64 — they belong in the report, not
      // in an MCP response that a model has to read. A recording is the same
      // argument several times over: it is the largest single thing a bundle
      // can carry, and there is nothing a model can do with a webm.
      const steps_ = bundle.steps.map(({ screenshot, ...rest }) => ({
        ...rest,
        hasScreenshot: screenshot !== undefined,
      }));
      const { video, ...rest_ } = bundle;

      return json({
        ...rest_,
        steps: steps_,
        // The facts about the recording, without the recording.
        video: video ? { width: video.width, height: video.height, bytes: video.bytes } : undefined,
        proofPath,
        reportPath,
      });
    },
  );

  server.registerTool(
    'repair_flow',
    {
      title: 'Run a flow, self-repairing on failure',
      description:
        'Like run_flow, but on failure asks the generator role to propose a targeted fix — a ' +
        'different selector, or steps to insert before the failing one — and retries, up to ' +
        'maxAttempts total runs. Never overwrites anything: each attempt is written as a new, ' +
        'complete .flow.json plus a human-readable .patch file explaining the change. Returns ' +
        'deadEnd: true, not an error, once attempts are exhausted and the flow still fails.',
      inputSchema: {
        name: z.string().describe('Human-readable name for this run.'),
        baseUrl: z.string().optional().describe('Prefix for relative goto urls.'),
        steps: z.array(flowStepSchema).min(1).describe('Ordered steps to execute.'),
        setup: z
          .array(flowStepSchema)
          .optional()
          .describe('Preconditions run before steps; a failure here aborts the flow.'),
        teardown: z
          .array(flowStepSchema)
          .optional()
          .describe('Cleanup, always run — including after a failure.'),
        maxAttempts: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Total attempts, including the first, unmodified run (default 3).'),
        outDir: z
          .string()
          .optional()
          .describe('Where reviewable .flow.json/.patch files land (default: the report directory).'),
        investigate: z
          .boolean()
          .optional()
          .describe(
            'Before each fix, an agent revisits the page and reinvestigates the failed step ' +
              'live — opening menus, waiting, scrolling — and the fix is proposed against the ' +
              'page it opened up. Acts on the application; off by default.',
          ),
        regenerateFrom: z
          .boolean()
          .optional()
          .describe(
            'Allow a fix to regenerate the flow from the failed step onward — replacing the ' +
              'failed step and every later step in its section. Steps before the failure are ' +
              'never touched. Off by default.',
          ),
      },
    },
    async ({ name, baseUrl, steps, setup, teardown, maxAttempts, outDir, investigate, regenerateFrom }) => {
      const flow: Flow = { name, baseUrl, steps, setup, teardown };

      const loop = new FlowRepairLoop({
        model: new LlmFlowRepairModel({ factory: config.factory }),
        maxAttempts,
        outDir: outDir ?? config.reportDir,
        agent:
          investigate === true
            ? new WorkflowAgent({ model: new LlmAgentModel({ factory: config.factory }) })
            : null,
        regenerateFrom,
        runOptions: {
          cdpUrl: config.cdpUrl,
          cachePath: config.cachePath,
          screenshots: config.screenshots,
          video: config.video,
          makeHealer: config.healing
            ? (cache) =>
                new JitHealer({ model: new LlmHealerModel({ factory: config.factory }), cache })
            : undefined,
          healer: config.healing ? undefined : null,
          agent: config.agent
            ? new WorkflowAgent({ model: new LlmAgentModel({ factory: config.factory }) })
            : null,
          dataModel: new LlmDataModel({ factory: config.factory }),
        },
      });

      const outcome = await loop.run(flow, slugify(name));

      // Screenshots are megabytes of base64 — same reasoning as run_flow.
      const attempts = outcome.attempts.map((a) => ({
        attempt: a.attempt,
        status: a.bundle.status,
        runId: a.bundle.runId,
        repair: a.repair,
        investigation: a.investigation,
        steps: a.bundle.steps.map(({ screenshot, ...rest }) => ({
          ...rest,
          hasScreenshot: screenshot !== undefined,
        })),
        hasVideo: a.bundle.video !== undefined,
      }));

      return json({ status: outcome.status, deadEnd: outcome.status === 'dead-end', attempts });
    },
  );

  server.registerTool(
    'generate_tests',
    {
      title: 'Generate a test suite from a live page',
      description:
        'Open a URL, read its accessibility tree, and have Claude write functional, edge-case, ' +
        'and usability test flows for it — plus any defects visible in the tree itself. ' +
        'Returns runnable flows that can be passed straight to run_flow.',
      inputSchema: {
        url: z.string().describe('Page to scan.'),
        focus: z.string().optional().describe('Steer generation, e.g. "the filter controls".'),
        maxCases: z.number().int().min(1).max(20).optional().describe('Cap cases (default 6).'),
        policy: z
          .enum(MUTATION_POLICIES)
          .optional()
          .describe(
            "How much the suite may change. 'forms' (default) submits only empty/invalid input to exercise validation; 'read-only' never submits; " +
              "'forms' submits empty/invalid input to exercise validation (negative testing); " +
              "'mutations' may also create or update. None ever delete.",
          ),
        context: z
          .boolean()
          .optional()
          .describe(
            'Include repository context (routes, components, what already covers this page) ' +
              'in the prompt. Static analysis only, no model call. Off by default.',
          ),
      },
    },
    async ({ url, focus, maxCases, policy, context }) => {
      const projectGraph = context ? await new ContextEngine().build() : undefined;
      const generator = new TestGenerator({
        model: new LlmGeneratorModel({ factory: config.factory }),
        maxCases: maxCases ?? 6,
        policy: policy ?? DEFAULT_MUTATION_POLICY,
        projectGraph,
      });

      try {
        const suite = await withPage(config.cdpUrl, async (page) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
          return generator.generate(page, focus);
        });
        return json(suite);
      } catch (error) {
        return failure(`generation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    'get_project_context',
    {
      title: 'Read the repository context graph',
      description:
        'Statically indexes the project (package.json, React/Next routes and components, ' +
        'existing tests) into a graph — no model call. Without `url`, returns route names and ' +
        'counts so a caller can pick one. With `url`, returns the slice `generate_tests` would ' +
        'see: what that route renders, what it uses, and what already covers it.',
      inputSchema: {
        url: z.string().optional().describe('Center the context on this page.'),
        force: z.boolean().optional().describe('Rebuild even if the graph looks unchanged.'),
        openapi: z
          .string()
          .optional()
          .describe('Path or URL of an OpenAPI/Swagger spec to index alongside the code.'),
        dbSchema: z
          .string()
          .optional()
          .describe('Path of a schema.sql / schema.prisma to index alongside the code.'),
      },
    },
    async ({ url, force, openapi, dbSchema }) => {
      const engine = new ContextEngine({
        ...(openapi === undefined ? {} : { openApiSpec: openapi }),
        ...(dbSchema === undefined ? {} : { dbSchema }),
      });
      const graph = await engine.build({ force: force ?? false });

      if (url === undefined) {
        return json({
          summary: summarizeContext(graph),
          routes: graph.nodes.filter((node) => node.kind === 'route').map((node) => node.name),
          operations: graph.nodes
            .filter((node) => node.kind === 'operation')
            .map((node) => node.name),
          tables: graph.nodes.filter((node) => node.kind === 'table').map((node) => node.name),
        });
      }
      return json({ promptContext: toPromptContext(graph, { url }) });
    },
  );

  server.registerTool(
    'get_proof_bundle',
    {
      title: 'Read a stored proof bundle',
      description: 'Fetch a previously persisted proof bundle by its run id.',
      inputSchema: { runId: z.string().describe('The runId returned by run_flow.') },
    },
    async ({ runId }) => {
      if (!/^[A-Za-z0-9-]+$/.test(runId)) {
        return failure(`invalid runId: ${runId}`);
      }
      try {
        const raw = await readFile(join(config.proofDir, `${runId}.json`), 'utf8');
        return json(JSON.parse(raw) as ProofBundle);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return failure(`no proof bundle for run ${runId}: ${detail}`);
      }
    },
  );

  server.registerTool(
    'list_healed_selectors',
    {
      title: 'List healed selectors',
      description:
        'Inspect the healed-selector cache — which selectors have drifted, what they were ' +
        'repaired to, and how often each repair has been reused.',
      inputSchema: {
        urlContains: z.string().optional().describe('Only entries whose url contains this.'),
      },
    },
    async ({ urlContains }) => {
      const cache = new CacheManager({ filePath: config.cachePath });
      await cache.load();
      const entries = cache
        .entries()
        .filter((entry) => (urlContains ? entry.url.includes(urlContains) : true));
      return json({ cachePath: cache.filePath, count: entries.length, entries });
    },
  );

  server.registerTool(
    'forget_healed_selector',
    {
      title: 'Invalidate healed selectors',
      description:
        'Drop one cached repair (by key) or the whole cache. Use after a UI change to force ' +
        'the next run to re-heal from scratch.',
      inputSchema: {
        key: z.string().optional().describe('Cache key to drop. Omit with all=true to clear.'),
        all: z.boolean().optional().describe('Clear every entry.'),
      },
    },
    async ({ key, all }) => {
      const cache = new CacheManager({ filePath: config.cachePath });
      await cache.load();

      if (all === true) {
        const removed = cache.size;
        cache.clear();
        await cache.flush();
        return json({ cleared: removed });
      }

      if (key === undefined) {
        return failure('provide either `key` or `all: true`');
      }

      const deleted = cache.delete(key);
      await cache.flush();
      return json({ key, deleted });
    },
  );

  return server;
}

export async function main(): Promise<void> {
  loadDotEnv();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// stdout is the MCP channel — diagnostics must go to stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[wowlidator-mcp] fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
