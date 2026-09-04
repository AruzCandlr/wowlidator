/**
 * Autonomous API test generation, from an OpenAPI spec.
 *
 * The UI generator works because the AX tree is a real inventory of the
 * controls that exist — the model chooses among facts rather than inventing
 * selectors. This is the same bargain for endpoints: the `operation` nodes the
 * OpenAPI ingester produced are the inventory, and a generated case may only
 * ever call something that is actually declared. Without a spec there is no
 * inventory, and this module simply refuses to run rather than guessing at
 * URLs.
 *
 * **No fifth LLM role.** This reuses `generator`, exactly as
 * `src/repair/flow-repair-model.ts` does, and for the same reason: the job
 * shape is identical — a large inventory in, a small flat structured shape
 * out.
 *
 * **The mutation policy is enforced structurally, not by asking nicely.** The
 * inventory handed to the model is filtered by policy before the prompt is
 * built, and every generated step is checked against the policy again on the
 * way out. A prompt instruction is a request; a filter is a guarantee. DELETE
 * is excluded at every tier, including `mutations` — the existing policy table
 * already says "never delete", and an autonomous test writer that can delete
 * production records is not something to opt out of.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import type { ProjectGraph, ProjectNode } from '../context/types.js';
import { hasAssertion } from '../engine/runner.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import type { Flow, FlowStep } from '../engine/runner.js';
import type { Defect, DefectCategory, DefectSeverity } from '../engine/proof-bundle.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import {
  DEFAULT_MUTATION_POLICY,
  TEST_KINDS,
  type GeneratedCase,
  type GeneratedSuite,
  type MutationPolicy,
  type RejectedCase,
  type TestKind,
} from './test-generator.js';

/** How many operations may reach the prompt. Same token-budget logic as the AX cap. */
export const DEFAULT_MAX_OPERATIONS = 60;

/**
 * Methods each policy tier may call.
 *
 * DELETE appears nowhere on purpose — see the module comment.
 */
const POLICY_METHODS: Record<MutationPolicy, ReadonlySet<string>> = {
  'read-only': new Set(['GET', 'HEAD', 'OPTIONS']),
  forms: new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH']),
  mutations: new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH']),
};

const POLICY_RULES: Record<MutationPolicy, string> = {
  'read-only': `- Call ONLY the read operations listed. Never send POST, PUT, PATCH or DELETE.
- Good read-only cases: a successful fetch, a missing resource (expect 404), a
  malformed query parameter, a request with no authentication (expect 401/403).`,
  forms: `- You MAY send POST/PUT/PATCH with INVALID or INCOMPLETE bodies to exercise validation,
  and you SHOULD: negative testing is where most real defects live. Omit a required
  field, send a string where a number belongs, exceed a documented maximum.
- Assert the SPECIFIC rejection: expectStatus 400/422, and where the spec documents an
  error shape, expectJson on the field that names the problem. Asserting only that the
  status is "not 200" distinguishes nothing.
- Do NOT send a VALID body that would create or modify a record.`,
  mutations: `- You MAY send POST/PUT/PATCH with valid bodies to create or update records, and you MAY
  send invalid ones to exercise validation. Assert the resulting state either way:
  a create should assert the returned id or echoed fields, not merely a 2xx.
- Prefer saving an id from the create response and reading it back — a create that is
  never read back proves the endpoint accepted the call, not that it did anything.`,
};

export const API_GENERATOR_ACTIONS = [
  'request',
  'expectStatus',
  'expectJson',
  'expectHeader',
] as const;

/**
 * Flat, every field required, narrowed in code — the same rule the UI
 * generator follows, for the same reason: weaker free-tier models handle a
 * flat object far more reliably than a discriminated union.
 */
export const GeneratedApiStepSchema = z.object({
  action: z.enum(API_GENERATOR_ACTIONS),
  method: z.string().describe('HTTP method for a request step. Else empty.'),
  url: z.string().describe('Path for a request step, e.g. /orders/{{orderId}}. Else empty.'),
  body: z.string().describe('JSON request body as a string. Empty when there is none.'),
  save: z
    .string()
    .describe('Optional "name=$.json.path" to save a value from the response. Else empty.'),
  path: z.string().describe('JSON path for expectJson, e.g. $.data.id. Else empty.'),
  value: z.string().describe('Expected value for expectJson/expectHeader. Else empty.'),
  status: z.string().describe('Expected status for expectStatus, as a number string. Else empty.'),
  header: z.string().describe('Header name for expectHeader. Else empty.'),
  intent: z.string().describe('What this step is checking, in plain language.'),
});

const GeneratedApiCaseSchema = z.object({
  name: z.string(),
  kind: z.enum(TEST_KINDS),
  rationale: z.string().describe('Why this case is worth running.'),
  steps: z.array(GeneratedApiStepSchema),
});

const ApiGenerationSchema = z.object({
  cases: z.array(GeneratedApiCaseSchema),
  defects: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
      category: z.enum(['functional', 'usability', 'backend']),
      selector: z.string().describe('The operation the problem is in, e.g. "POST /orders".'),
    }),
  ),
});

export interface ApiGenerateRequest {
  /** Server base url from the spec, when it declared one. */
  baseUrl?: string | undefined;
  /** The filtered operation inventory, already rendered for the prompt. */
  inventory: string;
  focus?: string | undefined;
  maxCases: number;
  policy?: MutationPolicy | undefined;
}

export interface ApiGenerationResult {
  cases: Array<{ name: string; kind: TestKind; rationale: string; steps: FlowStep[] }>;
  defects: Array<Omit<Defect, 'id' | 'source'>>;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Pluggable backend, so the suite can be tested without a network call. */
export interface ApiGeneratorModel {
  readonly id: string;
  generate(request: ApiGenerateRequest): Promise<ApiGenerationResult>;
}

const buildSystemPrompt = (policy: MutationPolicy): string => `You design API test suites by reading an OpenAPI operation inventory.

Produce two things.

**cases** — runnable test flows. Cover three kinds:
- functional: the documented happy path for an operation
- edge-case: a missing resource, a malformed parameter, a boundary value, an absent
  required field, an unauthenticated call
- usability: a contract problem a consumer would trip over (an operation that
  documents no error responses, an inconsistent identifier shape between two
  operations, a required parameter with no description)

Actions available:
- request       make a call. "method" and "url"; JSON body as a string in "body".
                Optionally "save" as "name=$.json.path" to keep a value from the
                response for a later step to use as {{name}}.
- expectStatus  the last response's status equals "status".
- expectJson    the last response's body at "path" equals "value". Leave "value"
                empty to assert only that the path exists — right for a
                server-assigned id, whose exact value you cannot know.
- expectHeader  the last response's "header" equals "value".

**Every case MUST contain at least one expect* step.** A bare request proves
nothing: it passes whether the endpoint returns the right data or a 500, which is
worse than having no test at all because it displaces the manual check.

Only call operations that appear in the inventory below, with exactly the method
shown. An operation that is not listed does not exist as far as this suite is
concerned — do not infer one from a naming pattern, and do not "fix" a path you
think looks wrong.

Chain realistically: when a case needs an id, create or list first and save the id
from that response rather than inventing one. A hard-coded id that does not exist
turns a real assertion into a 404 that tells you nothing about the behaviour you
meant to test.

- Leave unused fields as empty strings.
${POLICY_RULES[policy]}

${DETERMINISM_RULES}

${procedure('HOW TO BUILD THE SUITE', [
  'Walk the inventory in the order given. For each operation the policy allows, decide its ONE functional case; then, still in inventory order, the edge cases the policy allows; usability cases only for a contract problem the inventory positively shows. Stop at the case limit — earlier operations win.',
  'Name each case "<kind>: <METHOD /path> <what it proves>", the method and path verbatim from the inventory.',
  'For a case that needs an id: the first step lists or creates and saves it as {{id}}; never a literal id.',
  'Every request is followed by an expectStatus, and every functional case additionally by an expectJson on a field the inventory documents.',
])}

${selfCheck([
  'Every method+path used appears in the inventory exactly as written.',
  'Every case has at least one expect* step, and every request has an expectStatus after it.',
  'No literal id is invented; ids come from a saved response.',
  'The policy\'s limits hold: no writes under read-only, only invalid payloads under forms, never DELETE.',
])}

**defects** — problems visible in the spec itself, with no run required: an
operation with no documented error responses, a required parameter with no
description, inconsistent identifier or pagination conventions between related
operations, a mutating operation with no declared authentication.

Report only what the inventory actually shows. If it looks clean, return an empty
defects array — do not invent problems to seem thorough. If the inventory ends with
a TRUNCATED notice it is INCOMPLETE: never report a defect whose evidence is that
something is absent, because the absent thing may simply be past the cut.`;

function buildUserPrompt(request: ApiGenerateRequest): string {
  const lines = [`Generate at most ${request.maxCases} test cases.`];
  if (request.baseUrl) lines.push(`Server base url: ${request.baseUrl}`);
  if (request.focus) lines.push(`Focus area: ${request.focus}`);
  lines.push('', 'Operations:', request.inventory);
  return lines.join('\n');
}

export interface LlmApiGeneratorModelOptions {
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

export class LlmApiGeneratorModel implements ApiGeneratorModel {
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  readonly #explicitId: string | undefined;
  readonly #factory: LlmFactory | undefined;

  constructor(options: LlmApiGeneratorModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:api-generator';
      this.#factory = undefined;
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.#explicitId = options.id;
      this.#factory = factory;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 8192;
  }

  /**
   * Lazy, like `LlmDataModel.id` and `LlmFlowRepairModel.id`.
   *
   * Constructing this class must never itself demand an API key — a run that
   * never generates anything should never be asked for one.
   */
  get id(): string {
    return this.#explicitId ?? this.#factory?.forRole('generator').id ?? 'generator';
  }

  async generate(request: ApiGenerateRequest): Promise<ApiGenerationResult> {
    const policy = request.policy ?? DEFAULT_MUTATION_POLICY;
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: ApiGenerationSchema,
      system: buildSystemPrompt(policy),
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      // Re-applied here: models routinely ignore "at most N".
      cases: object.cases.slice(0, request.maxCases).map((testCase) => ({
        name: testCase.name,
        kind: testCase.kind,
        rationale: testCase.rationale,
        steps: testCase.steps
          .map((step) => toApiFlowStep(step, policy))
          .filter((step): step is FlowStep => step !== null),
      })),
      defects: object.defects.map((defect) => ({
        title: defect.title,
        detail: defect.detail,
        severity: defect.severity as DefectSeverity,
        category: defect.category as DefectCategory,
        selector: defect.selector === '' ? undefined : defect.selector,
      })),
      inputTokens,
      outputTokens,
    };
  }
}

/** `"orderId=$.data.id"` → `{ orderId: '$.data.id' }`. Ignores malformed entries. */
function parseSave(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const name = entry.slice(0, at).trim();
    const path = entry.slice(at + 1).trim();
    if (name === '' || path === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    out[name] = path;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Narrow the flat generated shape into the runner's step union.
 *
 * The policy check here is the structural guarantee behind the prompt's
 * request: a model that ignores the instruction and emits a DELETE produces
 * `null`, not a step.
 */
export function toApiFlowStep(
  raw: z.infer<typeof GeneratedApiStepSchema>,
  policy: MutationPolicy = 'read-only',
): FlowStep | null {
  const intent = raw.intent === '' ? undefined : raw.intent;
  switch (raw.action) {
    case 'request': {
      const method = raw.method.trim().toUpperCase();
      if (method === '' || raw.url === '') return null;
      if (!POLICY_METHODS[policy].has(method)) return null;
      const save = parseSave(raw.save);
      let body: unknown;
      if (raw.body !== '') {
        try {
          body = JSON.parse(raw.body);
        } catch {
          // Not JSON — send it as-is rather than dropping the step; some
          // endpoints take form-encoded or plain-text bodies.
          body = raw.body;
        }
      }
      return {
        action: 'request',
        method,
        url: raw.url,
        ...(body === undefined ? {} : { body }),
        ...(save === undefined ? {} : { save }),
        intent,
      };
    }
    case 'expectStatus': {
      const status = Number(raw.status);
      return Number.isInteger(status) && status >= 100 && status <= 599
        ? { action: 'expectStatus', status, intent }
        : null;
    }
    case 'expectJson':
      return raw.path === ''
        ? null
        : {
            action: 'expectJson',
            path: raw.path,
            ...(raw.value === '' ? {} : { value: raw.value }),
            intent,
          };
    case 'expectHeader':
      return raw.header === '' || raw.value === ''
        ? null
        : { action: 'expectHeader', name: raw.header, value: raw.value, intent };
    default:
      return null;
  }
}

/** Render one operation node as a prompt line. */
function describeOperation(node: ProjectNode): string {
  const meta = node.meta ?? {};
  const parts = [`- ${meta['method']} ${meta['path']}`];
  if (node.detail) parts.push(`  ${node.detail}`);
  if (meta['parameters']) parts.push(`  params: ${meta['parameters']}`);
  if (meta['requestBody']) parts.push(`  body: ${meta['requestBody']}`);
  if (meta['responses']) parts.push(`  responses: ${meta['responses']}`);
  if (meta['secured'] === 'true') parts.push('  requires authentication');
  if (meta['deprecated'] === 'true') parts.push('  DEPRECATED');
  return parts.join('\n');
}

export class NoSpecError extends Error {
  override readonly name = 'NoSpecError';
}

export interface ApiTestGeneratorOptions {
  model: ApiGeneratorModel;
  /** Graph containing `operation` nodes — build it with `ContextEngine`. */
  projectGraph: ProjectGraph;
  maxCases?: number | undefined;
  maxOperations?: number | undefined;
  policy?: MutationPolicy | undefined;
  onLog?: ((line: string) => void) | undefined;
}

export class ApiTestGenerator {
  readonly model: ApiGeneratorModel;

  readonly #graph: ProjectGraph;
  readonly #maxCases: number;
  readonly #maxOperations: number;
  readonly #policy: MutationPolicy;
  readonly #onLog: ((line: string) => void) | undefined;

  constructor(options: ApiTestGeneratorOptions) {
    this.model = options.model;
    this.#graph = options.projectGraph;
    this.#maxCases = options.maxCases ?? 6;
    this.#maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.#policy = options.policy ?? DEFAULT_MUTATION_POLICY;
    this.#onLog = options.onLog;
  }

  /** Operations this policy is allowed to touch, in spec order. */
  operations(): ProjectNode[] {
    const allowed = POLICY_METHODS[this.#policy];
    return this.#graph.nodes.filter(
      (node) => node.kind === 'operation' && allowed.has(node.meta?.['method'] ?? ''),
    );
  }

  async generate(focus?: string): Promise<GeneratedSuite> {
    const startedMs = Date.now();
    const all = this.operations();
    if (all.length === 0) {
      // Refusing is the honest answer: with no inventory, anything generated
      // would be invented endpoints, and a suite of 404s is worse than none.
      throw new NoSpecError(
        this.#graph.nodes.some((node) => node.kind === 'operation')
          ? `no operations are callable under the "${this.#policy}" policy — ` +
            'the spec declares only mutating endpoints, so raise the policy or narrow the spec'
          : 'no API operations are indexed — run `wowlidator context build --openapi <spec>` first',
      );
    }

    const shown = all.slice(0, this.#maxOperations);
    const truncated = shown.length < all.length;
    const inventory =
      shown.map(describeOperation).join('\n') +
      (truncated
        ? `\n\n[TRUNCATED: showing ${shown.length} of ${all.length} operations]`
        : '');
    const baseUrl = shown[0]?.meta?.['base'];

    this.#onLog?.(
      `read ${all.length} operation(s)${truncated ? `, sending ${shown.length}` : ''}; ` +
        'asking the generator role for API test cases…',
    );

    const result = await this.model.generate({
      baseUrl,
      inventory,
      focus,
      maxCases: this.#maxCases,
      policy: this.#policy,
    });

    const cases: GeneratedCase[] = [];
    const rejected: RejectedCase[] = [];

    for (const testCase of result.cases) {
      // Identical rule to the UI generator, and it matters more here: a
      // `request` on its own is not an assertion, so an unchecked call is the
      // easiest possible way to produce a suite that proves nothing.
      const reason =
        testCase.steps.length === 0
          ? 'no usable steps survived validation'
          : !hasAssertion(testCase.steps)
            ? 'no assertion — the case would pass without proving anything'
            : !testCase.steps.some((step) => step.action === 'request')
              ? 'no request — nothing to assert against'
              : null;

      if (reason !== null) {
        rejected.push({ name: testCase.name, kind: testCase.kind, reason });
        continue;
      }

      const flow: Flow = {
        name: testCase.name,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        steps: testCase.steps,
      };
      cases.push({
        name: testCase.name,
        kind: testCase.kind,
        rationale: testCase.rationale,
        flow,
      });
    }

    const defects: Defect[] = result.defects.map((defect, index) => ({
      id: `gen-${index + 1}`,
      source: 'generator',
      severity: defect.severity,
      category: defect.category,
      title: defect.title,
      detail: defect.detail,
      selector: defect.selector,
    }));

    this.#onLog?.(
      `got ${cases.length} case(s)${rejected.length > 0 ? `, ${rejected.length} rejected` : ''} and ${defects.length} defect(s)`,
    );

    return {
      sourceUrl: baseUrl ?? 'openapi',
      model: this.model.id,
      generatedAt: new Date().toISOString(),
      cases,
      rejected,
      defects,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedMs,
    };
  }
}
