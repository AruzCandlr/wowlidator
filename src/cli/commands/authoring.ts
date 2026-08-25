/**
 * The commands that write tests: generate, author, draft, and catalog.
 * Split out of cli.ts verbatim.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Page } from 'playwright';

import {
  LlmCatalogModel,
  approvedClaims,
  buildAuthoringPrompt,
  extractClaims,
  parseClaimsFile,
  toClaimsFile,
  type ClaimsFile,
} from '../../catalog/catalog.js';
import { LlmDraftModel, draftCatalog } from '../../catalog/draft.js';
import { extractDocumentFile } from '../../catalog/extract.js';
import { CONTEXT_DOC_MAX_CHARS, referencedSources, selectRelevantContext } from '../../catalog/retrieve.js';
import { bm25 } from '../../context/relevance.js';
import {
  parseSequenceDiagram,
  recomputeLaneTestability,
  sequenceToClaims,
  toGateInfo,
  type SequenceDoc,
} from '../../catalog/sequence.js';
import {
  describeCase,
  parseTestCaseTable,
  recordedResult,
  renderTestCaseTable,
  tableToClaims,
  type TestCaseRow,
} from '../../catalog/test-case-table.js';
import {
  LlmDiagramTranscriber,
  isDiagramImage,
  transcribeDiagramImage,
} from '../../catalog/diagram-image.js';
import { ContextEngine } from '../../context/context-engine.js';
import { findRouteForUrl, routesForDescription, toPromptContext } from '../../context/query.js';
import { concreteRouteUrl } from '../../context/route-match.js';
import {
  graphFileFor,
  navDestination,
  resolveRepo,
  upsertRepo,
  type NavLink,
  type NavMap,
} from '../../context/repo-registry.js';
import type { ProjectGraph } from '../../context/types.js';
import { formatCoverage, meaningfulCoverage } from '../../coverage/ax-coverage.js';
import {
  formatProofSummary,
  writeProofBundle,
  type GenerationProvenance,
} from '../../engine/proof-bundle.js';
import { runFlow, withPage, withPages, type Flow } from '../../engine/runner.js';
import { pilotCapture } from '../../context/capture-pilot.js';
import {
  ApiTestGenerator,
  LlmApiGeneratorModel,
  NoSpecError,
} from '../../generator/api-test-generator.js';
import { statedPolarity } from '../../engine/polarity.js';
import {
  AuthoringError,
  DEFAULT_AUTHOR_MAX_NODES,
  FlowAuthor,
  LOGIN_URL_PATTERN,
  LlmFlowAuthorModel,
  caseFlows,
  type AuthoredFlow,
} from '../../generator/flow-author.js';
import { LlmGeneratorModel, TestGenerator } from '../../generator/test-generator.js';
import type { GeneratedSuite } from '../../generator/test-generator.js';
import { captureAxNodes, captureAxTree } from '../../healer/jit-healer.js';
import { performSignIn, acceptConsentGate } from '../../engine/sign-in.js';
import { probeInteractions } from '../../context/page-probe.js';
import { formatTrend } from '../../history/run-history.js';
import {
  reportGroupForUrl,
  resolveReportPath,
  slugify,
  writeHtmlReport,
} from '../../reporter/html-reporter.js';
import {
  applyQuarantine,
  catalogFlowPath,
  cleanupChrome,
  flowFilename,
  openReport,
  pageDir,
  prepare,
  writeFlowFile,
  writeMachineReports,
} from '../artifacts.js';
import { EXIT, exitCodeFor, suiteExit, type CaseOutcome } from '../exit.js';
import {
  isErrorOutcome,
  isFailedOutcome,
  ledgerPathFor,
  markForRerun,
  markVacuous,
  readLedger,
  remaining,
  summariseLedger,
  writeLedger,
} from '../suite-progress.js';
import { vacuousFlow } from '../../generator/vacuous.js';
import { CaseQueue, DEFAULT_CONCURRENCY, ScenarioGate, authorWorkers, mapPool } from '../case-plan.js';
import { healHintsFrom } from '../../context/heal-hints.js';
import type { CliOptions } from '../options.js';
import { pauseRequested } from '../pause.js';
import {
  assertRolesResolvable,
  buildAgent,
  buildCapturePilot,
  buildDataModel,
  buildFlowReviewer,
  buildHealer,
  buildStepRepair,
  lineLogger,
  planLogger,
  stepLogger,
} from '../runtime.js';
import { runCases, type SuiteCase } from '../run-cases.js';

export async function cmdGenerate(url: string | undefined, options: CliOptions): Promise<number> {
  // `--api` reads the indexed spec rather than a page, so it needs no url.
  if (!url && !options.api) {
    process.stderr.write('wowlidator generate: missing <url>\n');
    return 2;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator generate: ${gate}\n`);
    return EXIT.environment;
  }

  const blocked = await prepare(options, url);
  if (blocked !== null) return blocked;

  const log = lineLogger(options);

  // Static, no model call — see cmdContext. Purely additive to the prompt.
  // A saved repo (--repo) outranks the cwd build: it names the application
  // under test explicitly, and an unknown selection fails loudly here.
  let repoContextGraph: ProjectGraph | null = null;
  try {
    repoContextGraph = await loadRepoGraph(options, log ?? undefined);
  } catch (error) {
    process.stderr.write(`wowlidator generate: ${(error as Error).message}\n`);
    return 2;
  }
  const projectGraph =
    repoContextGraph ??
    (options.context || options.api
      ? await new ContextEngine({
          rootDir: options.root,
          cacheFile: options.contextOut,
          openApiSpec: options.openapi,
        }).build()
      : undefined);

  let suite: GeneratedSuite;
  if (options.api) {
    // The spec is the inventory here, exactly as the AX tree is for a page.
    const apiGenerator = new ApiTestGenerator({
      model: new LlmApiGeneratorModel({ factory: options.factory }),
      projectGraph: projectGraph!,
      maxCases: options.maxCases,
      policy: options.policy,
      onLog: log,
    });
    try {
      suite = await apiGenerator.generate(options.focus);
    } catch (error) {
      if (error instanceof NoSpecError) {
        // Refusing is the honest answer — say why, don't dump a stack.
        process.stderr.write(`wowlidator generate --api: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  } else {
    const generator = new TestGenerator({
      model: new LlmGeneratorModel({ factory: options.factory }),
      maxCases: options.maxCases,
      policy: options.policy,
      projectGraph,
      probe: options.probe,
      onLog: log,
    });

    log?.(`opening ${url}…`);
    const pilot = buildCapturePilot(options);
    suite = await withPage(options.cdp, async (page) => {
      await page.goto(url!, { waitUntil: 'domcontentloaded' });
      // Give client-rendered pages a beat before reading the AX tree.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      // Then let the agent *look*: a heuristic can wait for the network, only
      // judgement can tell "still loading" from "loaded and empty".
      if (pilot) await pilotCapture(page, pilot, log);
      return generator.generate(page, options.focus);
    });
  }

  // Everything this command produces for this page goes in one folder.
  const group = reportGroupForUrl(suite.sourceUrl);
  const dir = pageDir(options, group);
  const suitePath = options.suite === undefined ? join(dir, 'suite.json') : resolve(options.suite);

  await mkdir(resolve(suitePath, '..'), { recursive: true });
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `generated ${suite.cases.length} case(s) and ${suite.defects.length} defect(s) from ${suite.sourceUrl}\n` +
      `  model      ${suite.model} (${suite.latencyMs}ms, ${suite.inputTokens ?? 0} in / ${suite.outputTokens ?? 0} out tokens)\n` +
      `  folder     ${dir}\n` +
      `  suite      ${suitePath}\n`,
  );
  for (const testCase of suite.cases) {
    process.stdout.write(`  · [${testCase.kind}] ${testCase.name} (${testCase.flow.steps.length} steps)\n`);
  }
  // Surfaced, not silently dropped — a rising count means the prompt is slipping.
  for (const rejected of suite.rejected) {
    process.stdout.write(`  ✗ [${rejected.kind}] ${rejected.name} — rejected: ${rejected.reason}\n`);
  }

  // Each case is written out as a standalone flow whether or not it runs now,
  // so `wowlidator run <that file>` works later without re-generating.
  for (const [index, testCase] of suite.cases.entries()) {
    // Same reason as the catalog path: the file outlives the run, and a later
    // `wowlidator run` of it must land in this suite's group rather than
    // reading as a flow somebody wrote by hand.
    testCase.flow.authoredBy = {
      model: suite.model,
      generatedAt: suite.generatedAt,
      sourceUrl: suite.sourceUrl,
      kind: testCase.kind,
      rationale: testCase.rationale,
    };
    await writeFlowFile(
      join(
        dir,
        flowFilename({
          runId: '',
          name: testCase.name,
          status: 'generated',
          index: index + 1,
          kind: testCase.kind,
          group,
        }),
      ),
      testCase.flow,
    );
  }

  if (!options.run) return 0;

  // Execute every generated case, one report per case — and report on every one
  // of them, including any that could not be run at all. See `runCases`.
  const outcomes = await runCases(
    suite.cases.map((testCase, index) => ({
      name: testCase.name,
      flow: testCase.flow,
      kind: testCase.kind,
      // Static findings ride along with the first case so they aren't lost.
      defects: index === 0 ? suite.defects : undefined,
      generatedBy: {
        model: suite.model,
        generatedAt: suite.generatedAt,
        sourceUrl: suite.sourceUrl,
        kind: testCase.kind,
        rationale: testCase.rationale,
      },
    })),
    options,
    { dir, group, indexTitle: `wowlidator suite — ${group}` },
  );

  const ran = outcomes.flatMap((o) => (o.bundle === null ? [] : [o.bundle]));
  await writeMachineReports(ran, options);
  await openReport(outcomes.find((o) => o.reportPath !== undefined)?.reportPath ?? null, options);
  await cleanupChrome(options);

  return suiteExit(outcomes);
}

/**
 * Turn a described test into one runnable flow.
 *
 * With `--url` the model is given the page's accessibility tree and held to
 * selectors that appear in it. Without one it can only guess, so the result is
 * labelled ungrounded and every selector is flagged for hand-verification —
 * useful as a skeleton, never as something to trust into CI.
 */
/**
 * A catalog: a document of claims, turned into a test.
 *
 * Two phases on purpose, and the gate between them is the whole point — see
 * `src/catalog/catalog.ts`. `--claims-only` stops after listing what the
 * document asserts, which costs one cheap model call and no browser; the second
 * phase reads the (possibly pruned) claims file back and authors a flow that
 * covers exactly what survived.
 *
 * Running it in one go is allowed and is the wrong default: nothing has been
 * looked at, so a claim the model read out of a heading gets a browser and a
 * report of its own. The UI never does it; the flag exists for a script that
 * has already reviewed the catalog once.
 *
 * **The second phase produces several runs, not one.** A catalog asserts things
 * that are independent of each other, so it is authored as discrete cases and
 * each case is run on its own: one that fails is recorded, and the rest are
 * still checked. A single flow would stop at its first failure — correctly,
 * since everything after it is in an unknown state — and every remaining claim
 * would go unanswered while the report showed only the one that broke.
 */
/**
 * Construct a catalog from a description, some context documents, or a page.
 *
 * The other two ways in. `catalog <file>` starts from a sheet a team already
 * has; **Describe** and **Add Context** had nothing of the kind, and went
 * straight from a sentence to a flow — so what actually got run was never
 * written down anywhere a person could read, amend, or hand to a tester, and the
 * review gate that the catalog path is built around was skipped entirely.
 *
 * This writes the catalog instead, in the project's own format, and stops. It
 * runs nothing. What comes out is an ordinary catalog file, so the next step is
 * the ordinary catalog command and all three entrances meet at the same
 * reviewable table.
 *
 *   wowlidator draft "probation reviews" --url http://localhost:3000/…
 *   …edit the sheet…
 *   wowlidator catalog <that file> --url … --run
 */
export async function cmdDraft(subject: string | undefined, options: CliOptions): Promise<number> {
  const hasContext = options.contextDocs.length > 0;
  if ((subject === undefined || subject.trim() === '') && !hasContext) {
    process.stderr.write(
      'wowlidator draft: say what to cover, or give it something to read.\n\n' +
        '  wowlidator draft "the probation inbox"\n' +
        '  wowlidator draft --context-doc spec.md\n',
    );
    return EXIT.usage;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator draft: ${gate}\n`);
    return EXIT.environment;
  }

  const log = lineLogger(options);

  const contextDocs = [];
  try {
    for (const path of options.contextDocs) {
      contextDocs.push(await extractDocumentFile(resolve(path)));
    }
  } catch (error) {
    process.stderr.write(
      `wowlidator draft: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT.usage;
  }
  for (const context of contextDocs) {
    if (context.note !== '') process.stdout.write(`  ! ${context.name}: ${context.note}\n`);
  }

  // A page is optional and worth a lot when it is there: menu paths and control
  // names come out matching what is really on screen, rather than being invented
  // and then failing to resolve three commands later.
  let axTree: string | undefined;
  if (options.url !== undefined) {
    const blocked = await prepare(options, options.url);
    if (blocked !== null) return blocked;
    log?.(`reading ${options.url}…`);
    axTree = await withPage(options.cdp, async (page) => {
      await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      return captureAxTree(page, DEFAULT_AUTHOR_MAX_NODES);
    });
  }

  log?.('asking the generator role for the test cases…');
  let drafted;
  try {
    drafted = await draftCatalog(new LlmDraftModel({ factory: options.factory }), {
      description: subject ?? '',
      context: contextDocs,
      axTree,
      url: options.url,
      maxCases: options.maxDraftCases,
    });
  } catch (error) {
    process.stderr.write(
      `wowlidator draft: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT.failed;
  }

  if (drafted.rows.length === 0) {
    process.stderr.write(
      'wowlidator draft: no cases came back. Say more about what to cover, or ' +
        'add the spec with --context-doc.\n',
    );
    return EXIT.failed;
  }

  const target =
    options.catalogOut === undefined
      ? join(resolve(options.reportDir), 'catalogs', `${slugify(drafted.subject || subject || 'catalog')}.csv`)
      : resolve(options.catalogOut);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, renderTestCaseTable(drafted.rows), 'utf8');

  const scenarios = new Set(drafted.rows.map((row) => row.scenarioId));
  const negative = drafted.rows.filter((row) => row.polarity === 'Negative').length;

  process.stdout.write(
    `drafted ${drafted.rows.length} case(s) across ${scenarios.size} scenario(s) — ${drafted.subject}\n` +
      `  model      ${drafted.model} (${drafted.latencyMs}ms, ${drafted.inputTokens ?? 0} in / ${drafted.outputTokens ?? 0} out tokens)\n` +
      `  grounded   ${axTree === undefined ? 'NO — no page was read, so menu paths are guesses' : `yes — against ${options.url}`}\n` +
      `  negative   ${negative} of ${drafted.rows.length}\n` +
      `  catalog    ${target}\n`,
  );
  for (const row of drafted.rows) {
    process.stdout.write(`    ${row.caseId} [${row.priority}] ${row.testCase}\n`);
  }
  process.stdout.write(
    '\nNothing has been run. This is a catalog, not a test — read it, strike out ' +
      'what you do not want, then:\n' +
      `  wowlidator catalog ${target} --url <page> --run\n`,
  );

  return EXIT.ok;
}

/**
 * One authored flow per table row, against one open page.
 *
 * The page is opened once and every row is authored against it: the browser is
 * the slow part, not the model, and reconnecting twelve times to read the same
 * accessibility tree would be the expensive way to get the same tree.
 *
 * **A row that cannot be authored does not stop the others.** Same rule as
 * running them: the sheet asked twelve questions, and one the model could not
 * express is not a reason to answer none of the rest. It is reported and the
 * loop goes on.
 */
/** The authoring summary: what was written, by which model, and where. */
function printAuthored(
  authored: AuthoredFlow,
  cases: readonly { name: string; flow: Flow }[],
  flowPaths: readonly string[],
  claims: number,
  group: string | undefined,
  dir: string,
): void {
  const totalSteps =
    (authored.flow.setup?.length ?? 0) +
    authored.flow.steps.length +
    (authored.flow.teardown?.length ?? 0);

  process.stdout.write(
    `authored "${authored.flow.name}" — ${totalSteps} step(s) in ${cases.length} case(s) for ${claims} claim(s)\n` +
      `  model      ${authored.model} (${authored.latencyMs}ms, ${authored.inputTokens ?? 0} in / ${authored.outputTokens ?? 0} out tokens)\n` +
      `  grounded   ${authored.grounded ? `yes — selectors checked against ${authored.sourceUrl}` : 'NO — selectors are guesses; verify every one before trusting this'}\n` +
      (group === undefined ? '' : `  folder     ${dir}\n`),
  );
  for (const [index, testCase] of cases.entries()) {
    process.stdout.write(
      `  · ${testCase.name} (${testCase.flow.steps.length} steps)\n` +
        `    flow     ${flowPaths[index]}\n`,
    );
  }
  if (authored.droppedSteps > 0) {
    process.stdout.write(
      `  ! dropped ${authored.droppedSteps} malformed step(s) the model emitted\n`,
    );
  }
  if (authored.review !== undefined) {
    const r = authored.review;
    process.stdout.write(
      `  review     ${r.flagged} ungrounded step(s): ${r.replaced} repointed, ${r.inserted} inserted, ` +
        `${r.kept} confirmed, ${r.unsure} still unsure, ${r.rejected.length} proposal(s) rejected ` +
        `(${r.model}, ${r.latencyMs}ms, ${r.inputTokens} in / ${r.outputTokens} out tokens)\n`,
    );
    for (const line of r.notes) process.stdout.write(`    · ${line}\n`);
    for (const line of r.rejected) process.stdout.write(`    ! ${line}\n`);
  }
}

/** One authored row of a test-case table, with the sheet facts wowUI groups on. */
interface TableCase {
  name: string;
  flow: Flow;
  scenarioId: string;
  /** `<scenarioId> <scenario title>` — the collapsible group label in wowUI. */
  scenario: string;
  caseTitle: string;
  /** The sheet's recorded Actual Result, normalised — accuracy's ground truth. */
  knownResult?: 'passed' | 'failed' | undefined;
}

/**
 * `Flow.caseContext` for one sheet row — the compact card the runtime model
 * roles (healer, agent) read so a repair or a workflow turn knows the claim
 * the step serves. The sheet's own words, whitespace-folded and bounded:
 * context must never grow into a second copy of the catalog. The Note column
 * rides along because it is where a sheet says the things that decide honest
 * behaviour ("Cancelled", "KNOWN FAIL", "confirmed 22 Jul") — exactly what a
 * model needs before spending turns proving a removed feature absent.
 */
export function caseCard(row: TestCaseRow): string | undefined {
  const cut = (label: string, text: string, max: number): string | null => {
    const folded = text.replace(/\s+/g, ' ').trim();
    if (folded === '') return null;
    return `${label}: ${folded.length > max ? `${folded.slice(0, max)}…` : folded}`;
  };
  const lines = [
    cut('Case', `${row.caseId} ${row.testCase}`, 160),
    cut('Expected', row.expected, 420),
    cut('Test data', row.testData, 120),
    cut('Persona', row.persona, 80),
    cut('Note', row.note, 200),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? undefined : lines.join('\n');
}

async function authorEachRow(
  rows: readonly TestCaseRow[],
  author: FlowAuthor,
  options: CliOptions,
  context: {
    summary: string;
    context: readonly Awaited<ReturnType<typeof extractDocumentFile>>[];
    log: ((line: string) => void) | undefined;
    /** The saved repository's graph, for the per-row journey capture. */
    graph?: ProjectGraph | null | undefined;
    /**
     * Called the moment a row's case is complete, before the next row is
     * authored — the seam that lets a run start while authoring continues.
     * `first` is the pass's first authored flow, whose model and time stamp
     * every case of the pass (the group identity wowUI reads).
     */
    onCase?: ((testCase: TableCase, first: AuthoredFlow) => Promise<void>) | undefined;
    /**
     * Holds authoring to the scenario the runner is in (`ScenarioGate`).
     * Present only on the pipelined path — gating a run that starts after
     * the last row is authored would deadlock it by construction.
     */
    gate?: ScenarioGate | null | undefined;
  },
): Promise<{ first: AuthoredFlow; cases: TableCase[] }> {
  // Kept by sheet position, compacted at the end: rows authored side by side
  // finish in any order, and the list handed back must still read as the
  // sheet. (`onCase` fires in completion order — that is the point of it.)
  const slots: (TableCase | undefined)[] = new Array(rows.length).fill(undefined);
  let first: AuthoredFlow | undefined;
  const refused: string[] = [];
  const workers = authorWorkers(options.authorConcurrency, options.config.roles.generator.provider);
  if (workers === 1 && options.authorConcurrency === undefined && rows.length > 1) {
    context.log?.(
      `authoring rows one at a time: the generator role is on ${options.config.roles.generator.provider}, ` +
        'which answers one call at a time (pass --author-concurrency to override)',
    );
  }
  // Rows authored beside each other interleave their narration; the case id
  // in front is what keeps a line readable. A sequential run's output is
  // exactly what it was.
  const rowLog = (row: TestCaseRow): ((line: string) => void) | undefined =>
    workers > 1 && context.log ? (line) => context.log?.(`[${row.caseId}] ${line}`) : context.log;

  const authorRow = async (row: TestCaseRow, index: number, page?: Page): Promise<void> => {
    const log = rowLog(row);
    const scenarioKey = row.scenarioId || 'ungrouped';
    if (context.gate) {
      // Author no further than the scenario the runner is in: a row of a
      // later scenario waits here until every earlier scenario's cases have
      // finished running. Workers take rows in sheet order, so blocking the
      // next row blocks the pool — which is the point.
      await context.gate.waitFor(scenarioKey, () => pauseRequested());
      if (pauseRequested()) return;
    }
    // Per row, not once for the loop. Every row is authored in its own call
    // against the same open page, so whole context documents were multiplied
    // by the row count — a twelve-row sheet with one 120,000-character spec
    // spent roughly 360k input tokens on background, eleven-twelfths of it
    // about rows this call is not writing. The row's own steps and
    // expectations are the strongest query available anywhere in the system.
    const described = describeCase(row);
    // A row that CITES another source for its expected value ("as per the
    // Master Benefit List", "ตามเอกสาร Requirement") is the row whose own
    // words are the weakest query for that value — the value lives in the
    // cited document, and the citation is a few tokens drowned in step
    // narration. The cited phrases are boosted in the retrieval query
    // (repeated — term frequency is the lever BM25 actually has), so the
    // section holding the real value outranks sections that merely share the
    // row's step vocabulary, and the prompt below can demand the value be
    // quoted from it rather than invented.
    const cited = referencedSources(`${row.testCase}\n${described}`);
    const retrievalQuery =
      cited.length === 0
        ? `${row.testCase}\n${described}`
        : `${cited.join('\n')}\n${cited.join('\n')}\n${row.testCase}\n${described}`;
    if (cited.length > 0) {
      log?.(`  ${row.caseId}: the case cites ${cited.join('; ')} — retrieving it from the background and the repository`);
    }
    const selected = selectRelevantContext(context.context, retrievalQuery, {
      budgetChars: options.contextBudget,
      onWarn: (line) => process.stderr.write(`  ! ${line}\n`),
    });
    // One line per row in the narration, not a stdout note each: twelve
    // disclosure lines about background would bury the twelve about the cases.
    if (selected.retrieved) log?.(`  ${row.caseId}: ${selected.note}`);
    const prompt = buildAuthoringPrompt(
      [
        {
          claim: row.testCase,
          priority: row.priority || 'medium',
          source: row.caseId,
          testable: true,
        },
      ],
      { summary: context.summary, context: selected.documents, cases: [described] },
    );
    log?.(`writing ${row.caseId}: ${row.testCase}…`);
    // **Each row's journey ends on its own page, so each row gets its own
    // destination capture.** The journey capture used to exist only on the
    // `wow go "text"` path; a catalog of end-to-end rows was authored from the
    // sign-in page's tree alone, and every leg past it went to a `workflow`
    // step — measured, 228 of 416 step-seconds in one run, most of them
    // failing. Ranked against the row's own words (its steps and expected
    // output are the best query for "which route is this row about"), read
    // in a second tab so `page` stays the start page.
    const journeyTree =
      page === undefined
        ? undefined
        : await captureJourneyTree(page, options, context.graph ?? null, described, log, {
            // The Menu column is the sheet saying where the row goes, in the
            // application's own labels; the title and steps second.
            where: [row.menu, row.testCase, row.steps].filter((t) => t !== '').join('\n'),
          });
    // The repository slice ranked against THIS row's words — the shared
    // author-wide section describes the whole project; the routes that decide
    // this row's expectUrl and workflow destination are the row's own. The
    // cited phrases ride along for the same reason they boost the document
    // query: a row deferring to "the master list" may be naming a table or
    // component the graph declares.
    const rowProjectContext = repoPromptSection(
      context.graph ?? null,
      options.url,
      log,
      cited.length === 0 ? described : `${described}\n${cited.join('\n')}`,
    );
    try {
      const one = await author.author(prompt, page, {
        journeyTree,
        ...(rowProjectContext === '' ? {} : { projectContext: rowProjectContext }),
      });
      first ??= one;
      // The sheet's own Positive/Negative column is the author's word on what
      // this row means to prove; it travels in the flow file so every run of
      // it — including re-runs and repairs — reports the same reading. A
      // blank cell stays blank and `runFlow` infers deterministically.
      const polarity = statedPolarity(row.polarity);
      // The card the runtime roles read (`Flow.caseContext`): the claim in
      // the sheet's own words, so a heal or an agent turn knows what the step
      // is proving — not only which selector broke. Bounded, and in the file
      // so re-runs and repairs keep it, the `authoredBy` rule.
      const card = caseCard(row);
      // The sheet's recorded Actual Result, when it holds one: the ground
      // truth accuracy compares this case's verdict against. Travels on the
      // provenance stamp, like scenario and caseTitle — a fact about the
      // sheet row, not about any one run.
      const knownResult = recordedResult(row.actual);
      const testCase: TableCase = {
        name: `${row.caseId} ${row.testCase}`,
        flow: {
          ...one.flow,
          name: `${row.caseId} ${row.testCase}`,
          ...(polarity === undefined ? {} : { polarity }),
          ...(card === undefined ? {} : { caseContext: card }),
        },
        scenarioId: row.scenarioId || 'ungrouped',
        scenario: `${row.scenarioId} ${row.scenario}`.trim() || 'ungrouped',
        caseTitle: row.testCase,
        ...(knownResult === undefined ? {} : { knownResult }),
      };
      slots[index] = testCase;
      await context.onCase?.(testCase, first);
      context.gate?.authored(scenarioKey);
    } catch (error) {
      if (!(error instanceof AuthoringError)) throw error;
      // A refused row still advances the gate: a scenario that authors
      // nothing must clear, or every scenario after it waits forever.
      context.gate?.authored(scenarioKey);
      refused.push(`${row.caseId}: ${error.message.split('\n')[0] ?? ''}`);
      process.stderr.write(`  ! ${row.caseId} could not be written — ${error.message.split('\n')[0]}\n`);
    }
  };

  // **Rows are authored in a pool, one start tab per worker.** Authoring a
  // row is mostly waiting on a model, and twelve rows waited one after the
  // other — measured at roughly a minute each. A worker owns its tab because
  // the probe and the capture pilot act on the start page (the AX read alone
  // would be safe to share); the per-row journey capture was already in a
  // fresh context of its own. Starts stay in sheet order, so the first case
  // queued is usually the first row of the sheet.
  const tabs = Math.min(workers, rows.length);
  if (options.url) {
    await withPages(options.cdp, tabs, async (pages) => {
      context.log?.(`opening ${options.url}${tabs > 1 ? ` in ${tabs} tabs` : ''}…`);
      for (const page of pages) {
        await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      }
      if (tabs > 1) context.log?.(`authoring ${rows.length} row(s), up to ${tabs} at a time`);
      await mapPool(rows, tabs, (row, index, slot) => authorRow(row, index, pages[slot]!), () => pauseRequested());
    });
  } else {
    await mapPool(rows, tabs, (row, index) => authorRow(row, index), () => pauseRequested());
  }
  const cases = slots.filter((c): c is TableCase => c !== undefined);

  if (first === undefined) {
    throw new AuthoringError(
      `none of the ${rows.length} case(s) could be written:\n  ${refused.join('\n  ')}`,
    );
  }
  // Never silent: a sheet of twelve that produced ten tasks must say so, or the
  // two that vanished look like rows nobody wrote.
  if (refused.length > 0) {
    process.stdout.write(
      `  ! ${refused.length} of ${rows.length} row(s) could not be turned into a test\n`,
    );
  }
  return { first, cases };
}

/**
 * Declared tables from the cached context graph, for the authoring prompt's
 * inventory section. Read-only (`load`, never `build`): indexing the schema is
 * `wowlidator context build --db-schema …`'s job, and authoring silently gaining a
 * project walk would be a surprise. Empty when no schema was ever indexed —
 * and with no inventory the author cannot emit a DB step at all.
 */
/** Tables sent to the author before relevance decides which ones matter. */
export const TABLE_INVENTORY_MAX = 40;

/** A table must score this much of the best table's score to be listed. */
const TABLE_SCORE_FLOOR = 0.35;

async function tableInventory(
  graph?: ProjectGraph | null,
  description?: string | undefined,
  log?: ((line: string) => void) | undefined,
): Promise<{ name: string; summary: string }[]> {
  try {
    // A selected repo's graph outranks the default cache: its tables are the
    // application actually being tested, not whatever was indexed last.
    const source = graph ?? (await new ContextEngine({ warn: false }).load());
    if (!source) return [];
    const all = source.nodes
      .filter((node) => node.kind === 'table')
      .map((node) => ({ name: node.name, summary: node.meta?.['columns'] ?? '' }));

    // THE PERMISSION TO CLAIM THE DATABASE IS EVIDENCE THAT THE FEATURE HAS AN
    // API. A schema indexed from a .sql file says the tables exist; it says
    // nothing about whether the screen under test ever reaches them. Measured:
    // an application with 386 indexed tables whose overtime and leave screens
    // are Zustand stores persisted to localStorage — every DB assertion the
    // author wrote against them fails on every run of a feature working
    // exactly as built, and files it against the backend.
    //
    // So the offer is gated on the repository declaring an API route this test
    // plausibly touches. `toFlowStep` already drops a DB step when no
    // inventory came with the request, which makes this structural rather than
    // a sentence in a prompt — the MutationPolicy move.
    //
    // The gate only engages when the repo declares API routes AT ALL. With
    // none, "this app has no backend" and "the backend lives in another
    // repository" are the same picture, and refusing on that would silently
    // remove DB testing from every split-repo project. Understate, never
    // overstate — the same rule attribution follows everywhere else.
    const apiRoutes = source.nodes.filter(
      (node) => node.kind === 'route' && node.meta?.['type'] === 'api',
    );
    if (apiRoutes.length > 0 && description !== undefined && description.trim() !== '') {
      const apiScores = bm25(
        apiRoutes.map((route) => `${route.name} ${route.file ?? ''}`),
        description,
      );
      if (Math.max(0, ...apiScores) <= 0) {
        log?.(
          `schema: ${all.length} table(s) indexed, but none of the ${apiRoutes.length} API route(s) ` +
            'this repository declares matches what is being tested — DB checks are not offered. ' +
            'A database claim needs evidence the feature reaches a backend; a screen that keeps ' +
            'its state in the browser would fail one on every run.',
        );
        return [];
      }
    }

    // The inventory is the largest thing in an authoring prompt by an order of
    // magnitude — measured on a real run, 386 tables with every column came to
    // 50,310 of the call's 56,237 input tokens, 89% of it, against 63 tokens of
    // what the person actually asked for. Cost is only half the reason to
    // narrow it: the same dump offered four near-identical candidates
    // (ot_request, ot_request_detail, ot_request_decision,
    // ot_request_attachment) for one journey, and which one comes back is
    // exactly the kind of coin-flip that makes two runs of one prompt disagree.
    if (description === undefined || description.trim() === '' || all.length <= TABLE_INVENTORY_MAX) {
      return all;
    }
    const scores = bm25(all.map((table) => `${table.name} ${table.summary}`), description);
    const best = Math.max(0, ...scores);
    // Nothing matched: the description names no table this schema has. Keeping
    // the whole inventory is the honest answer — narrowing to an arbitrary
    // forty would silently remove the ability to author a DB check at all,
    // and presence of the inventory IS the permission.
    if (best <= 0) return all;
    const kept = all
      .map((table, i) => ({ table, score: scores[i] ?? 0 }))
      .filter((entry) => entry.score >= best * TABLE_SCORE_FLOOR)
      .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name))
      .slice(0, TABLE_INVENTORY_MAX)
      .map((entry) => entry.table);
    log?.(
      `schema: ${kept.length} of ${all.length} table(s) match this test — the rest are not ` +
        'offered, so a DB check can only be written against these',
    );
    return kept;
  } catch {
    return [];
  }
}

/**
 * The saved repository this run is grounded in, when `--repo` names one.
 * Selection is explicit, so an unknown value throws (callers turn it into
 * exit 2) rather than silently skipping — a run that looks grounded while
 * grounding nothing is the failure mode this feature must not have. The graph
 * goes through `ContextEngine.build()`, whose signature check is the
 * staleness handling: unchanged repo → cached graph, changed repo →
 * transparent re-scan. The scan's openapi/db-schema inputs are carried from
 * the registry so a re-scan never silently drops endpoint or table nodes.
 */
async function loadRepoGraph(
  options: CliOptions,
  log?: ((line: string) => void) | undefined,
): Promise<ProjectGraph | null> {
  if (!options.repo) return null;
  const entry = await resolveRepo(options.repo);
  if (!entry) {
    throw new Error(
      `unknown repository "${options.repo}" — see saved ones with: wowlidator context list`,
    );
  }
  const engine = new ContextEngine({
    rootDir: entry.path,
    cacheFile: graphFileFor(entry.slug),
    openApiSpec: entry.openapi,
    dbSchema: entry.dbSchema,
    dbUrl: process.env['WOWLIDATOR_DB_URL'],
    dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
  });
  try {
    const graph = await engine.build();
    log?.(`repository context: ${entry.slug} (${graph.nodes.length} node(s))`);
    return graph;
  } catch (error) {
    // Degrade to the saved graph rather than failing the run: grounding is
    // insight, and a repo that cannot be re-scanned right now (moved, mid-
    // rebase, permissions) still has the graph the last scan produced. The
    // staleness is dated out loud — a silent stale graph would be worse than
    // none — and only a repo with no saved graph at all stays a hard error.
    const stale = await engine.load().catch(() => null);
    if (!stale) throw error;
    log?.(
      `repository ${entry.slug} could not be re-scanned (${(error as Error).message}) — ` +
        `using the graph saved ${entry.indexedAt} (${stale.nodes.length} node(s)); it may lag the code`,
    );
    return stale;
  }
}

/**
 * The repo's route-centred prompt section, with the empty case disclosed:
 * the walk starts at the route matching `url` **and at the routes the
 * description names**, so no url and no description (or nothing matching
 * either) means no section — silence there would read as "the repo declares
 * nothing" when the truth is "nothing was looked up".
 *
 * `description` is what makes this useful on the describe path. A journey
 * starts on one page and is about another: seeded from the start URL alone,
 * "log in, then create an overtime request" produced two lines about the login
 * screen out of a graph that held 71 nodes describing overtime — measured on
 * the saved `cnext-hrms-fortest` index, from a real `go` invocation.
 */
function repoPromptSection(
  graph: ProjectGraph | null,
  url: string | undefined,
  log?: ((line: string) => void) | undefined,
  description?: string | undefined,
): string {
  if (!graph) return '';
  const query = description?.trim() ?? '';
  const section =
    url !== undefined || query !== ''
      ? toPromptContext(graph, {
          ...(url === undefined ? {} : { url }),
          ...(query === '' ? {} : { query }),
        })
      : '';
  // `toPromptContext` reports a no-match as a sentence, not an empty string —
  // splicing that sentence in as "what the repository declares" would hand
  // the model a section that declares nothing. Both empty cases are logged,
  // never silent, and neither produces a section.
  if (section === '' || section.startsWith('Project context: no indexed route matches')) {
    log?.(
      url === undefined
        ? 'repository context: no url to look up a route for — authoring proceeds without the code section'
        : `repository context: no indexed route matches ${url} — authoring proceeds without the code section`,
    );
    return '';
  }
  return section;
}

/**
 * The accessibility tree of a page the description names, as a labelled
 * section — or nothing, with the reason logged.
 *
 * The ceiling this lifts: the tree authoring reads is the page the run STARTS
 * on, and for "log in, then create an overtime request" that is the login
 * screen. The journey's real controls are then invisible by construction, and
 * 9 of 9 measured authoring runs handed the middle of the test to a `workflow`
 * step — one of them saying so in its own notes ("Subsequent pages beyond
 * login are handled via workflow as they are absent from the initial login
 * accessibility tree").
 *
 * Every bound here is deliberate:
 *
 * - **One page, one navigation, no clicks.** This is a read, not an
 *   exploration; `--probe` and the capture pilot own the interacting.
 * - **A second tab, not the run's page.** The tree authoring grounds its
 *   selectors in must stay the start page's. Navigating the run's own page and
 *   coming back would silently swap it if the return failed; a tab in the same
 *   context shares the session and cannot.
 * - **Nothing is invented.** `concreteRouteUrl` refuses any pattern whose
 *   parameters this run cannot ground, and the refusal is logged rather than
 *   filled in.
 * - **A capture that bounced to a sign-in page is discarded.** With no session
 *   the destination redirects, and handing the model the login screen under
 *   the destination's name is worse than handing it nothing — it is exactly
 *   the mislabelling that a separate `journeyTree` field exists to prevent,
 *   arriving through the back door.
 * - **It never throws.** A failure here degrades to the capture authoring
 *   always did, the capture-pilot containment rule.
 */
/**
 * Fields a sign-in form needs, decided structurally rather than by name.
 *
 * `input[type="password"]` is a fact about the document, not a guess about
 * wording — which is what makes it safe to act on unsupervised. The identity
 * field is then whatever visible text-ish input shares the password's form,
 * and the submit control is only ever one that DECLARES itself
 * (`[type="submit"]`): an undeclared `<button>` inside a login form is as
 * likely to be "Sign in with Microsoft" as the submit, and clicking the wrong
 * one navigates someone's browser to an identity provider.
 */
const CONSENT_URL_PATTERN = /\/(consent|pdpa|terms|agreement)(\/|$|\?)/i;

/** Why a journey capture gave up, so the wording can be tested without a browser. */
export type JourneyCaptureGiveUp =
  | { kind: 'no-session'; target: string; landed: string }
  | { kind: 'no-form-field'; missing: string }
  | { kind: 'sign-in-refused'; email: string; landed: string };

/**
 * The line a person reads when the capture gives up. Pure on purpose: this is
 * a feature that acts on someone's application, and the account of what it did
 * — or declined to do — is part of the feature rather than a log detail.
 */
export function journeyCaptureNote(reason: JourneyCaptureGiveUp): string {
  switch (reason.kind) {
    case 'no-session':
      return (
        `${reason.target} redirected to ${reason.landed} — this run has no session yet, so the ` +
        'capture would be the sign-in page under another name. Pass --as <email>:<password> to ' +
        'sign in for the capture. Discarded.'
      );
    case 'no-form-field':
      return (
        `the sign-in page has ${reason.missing}, so nothing was clicked and the capture is ` +
        'discarded. Acting on a form this could not read would be a click on your application ' +
        'that nobody asked for.'
      );
    case 'sign-in-refused':
      return (
        `signed in as ${reason.email}, but the page is still ${reason.landed} — the credentials ` +
        'were refused, or the form needs a field this does not fill. Discarded.'
      );
  }
}

/**
 * Should the capture try to sign in here?
 *
 * Three conditions, all required. Credentials must have been supplied
 * EXPLICITLY (`--as` / `WOWLIDATOR_AS`) — nothing here invents or borrows one.
 * The landing page must actually look like a sign-in. And it must not already
 * have tried, because one attempt is the whole budget: a retry loop against an
 * unfamiliar login form is how an unattended tool locks an account.
 */
export function shouldSignInForCapture(state: {
  landedUrl: string;
  credentials: { email: string; password: string } | undefined;
  alreadyTried: boolean;
}): boolean {
  if (state.credentials === undefined) return false;
  if (state.alreadyTried) return false;
  return LOGIN_URL_PATTERN.test(state.landedUrl);
}


/**
 * One sign-in on the capture tab, so `--capture-journey` works cold.
 *
 * Measured: the journey capture succeeded in 3 of 3 runs today purely because
 * an earlier run had left a session in localStorage. Without one it lands on
 * the sign-in page and — correctly — discards, so on a fresh browser the flag
 * silently bought nothing.
 *
 * Never throws, never clicks something it could not identify, and never
 * touches the run's own page. On any doubt it returns the reason and the
 * caller degrades to authoring from the start page alone.
 */
async function signInOnCaptureTab(
  tab: Page,
  credentials: { email: string; password: string },
): Promise<{ ok: true } | { ok: false; reason: JourneyCaptureGiveUp }> {
  // The procedure lives in the engine now (`src/engine/sign-in.ts`) — the
  // runner's session bootstrap runs the same one, so a sign-in that works for
  // a capture works for a run and vice versa. This wrapper only maps the
  // engine's plain-string outcome onto the capture's typed give-up reasons.
  const outcome = await performSignIn(tab, credentials);
  if (outcome.ok) return { ok: true };
  return { ok: false, reason: { kind: 'no-form-field', missing: outcome.reason } };
}

/** Re-exported shape kept for the two capture callers below. */
async function passConsentGate(tab: Page): Promise<boolean> {
  return acceptConsentGate(tab);
}

/**
 * A tab in a context of its own, for anything that signs in on the person's
 * behalf to read a page.
 *
 * The capture tabs used to share the start page's context, and the state of
 * that context is whatever the last thing left there — measured on the live
 * application: a session with no consent decision, so every capture landed on
 * /en/consent and read the consent page as the destination. A fresh context
 * has nothing in it: the capture always signs in, always passes the gate, and
 * reads the page it meant to; and nothing it does can leak into the runs that
 * follow, which used to inherit the shared context's session. Closing the
 * context is the whole cleanup.
 */
async function openCaptureTab(page: Page): Promise<{ tab: Page; close: () => Promise<void> }> {
  const browser = page.context().browser();
  if (browser === null) {
    // No browser handle (an embedder's page): fall back to a tab beside it.
    const tab = await page.context().newPage();
    return { tab, close: () => tab.close().catch(() => undefined) };
  }
  const context = await browser.newContext();
  const tab = await context.newPage();
  return { tab, close: () => context.close().catch(() => undefined) };
}

/** How many shell tabs the navigation learner will switch through. */
const NAV_TAB_LIMIT = 8;
const NAV_TAB_SETTLE_MS = 400;

/** Repositories whose navigation this process already tried to learn. Once. */
const navLearnedThisProcess = new Set<string>();

/**
 * Read the application's own navigation from a signed-in shell, and remember
 * it with the repository.
 *
 * One tab, one sign-in (undone before the tab closes, exactly as the journey
 * capture does), the shell's links, plus whatever its ARIA-marked disclosures
 * reveal — a collapsed sidebar rail is one such disclosure and, on the
 * application this was measured against, the one that holds the whole menu
 * (19 links behind "ขยายเมนู", "Probation Reviews" among them). Bounded by
 * the probe's own budget and safety model: only disclosures are ever clicked.
 * Persisted on the registry entry so the next catalog run, and the next
 * session, read it for free. Never throws — a menu that could not be read is
 * a ranking that has to do without it, which is what it did before.
 */
async function learnNavigationMap(
  page: Page,
  options: CliOptions,
  slug: string,
  log?: ((line: string) => void) | undefined,
): Promise<NavMap | undefined> {
  if (options.url === undefined || !options.credentials) return undefined;
  let origin: string;
  try {
    origin = new URL(options.url).origin;
  } catch {
    return undefined;
  }
  let tab: Page | undefined;
  let closeTab: (() => Promise<void>) | undefined;
  try {
    ({ tab, close: closeTab } = await openCaptureTab(page));
    await tab.goto(options.url, { waitUntil: 'domcontentloaded' });
    await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    if (LOGIN_URL_PATTERN.test(tab.url())) {
      log?.(`navigation map: signing in as ${options.credentials.email} to read the application's menu…`);
      const outcome = await signInOnCaptureTab(tab, options.credentials);
      if (!outcome.ok || LOGIN_URL_PATTERN.test(tab.url())) {
        log?.(
          `navigation map: could not sign in (${outcome.ok ? `landed on ${tab.url()}` : journeyCaptureNote(outcome.reason)}) — the menu was not read`,
        );
        return undefined;
      }
    }
    await passConsentGate(tab);
    const links = new Map<string, NavLink>();
    const keep = (name: string, url: string, via?: string): void => {
      let path: string;
      try {
        const parsed = new URL(url, origin);
        if (parsed.origin !== origin) return;
        path = parsed.pathname;
      } catch {
        return;
      }
      const label = name.replace(/\s+/g, ' ').trim();
      if (label === '' || path === '/' || LOGIN_URL_PATTERN.test(path)) return;
      const key = `${label} → ${path}`;
      if (!links.has(key)) links.set(key, { label, path, ...(via === undefined ? {} : { via }) });
    };
    for (const node of await captureAxNodes(tab, 600)) {
      if (node.role === 'link' && node.url) keep(node.name, node.url);
    }
    const report = await probeInteractions(tab, { maxProbes: 8 });
    for (const probe of report.probes) {
      for (const node of probe.revealed) {
        if (node.role === 'link' && node.url) keep(node.name, node.url, probe.trigger);
      }
    }
    // **A shell's groups are tabs, and each tab shows a different set of
    // links.** On the measured application the sidebar is a rail of
    // `role="tab"` groups (Me / Org / Team / HR / Admin / Setup) — not
    // disclosures, so the probe above never opens them, and the panel only
    // ever shows the group the landing page belongs to. A tab is ARIA's own
    // word for "switches the view and does nothing else", which is why the
    // learner may click it where the general probe (whose blast radius is
    // every page a repair touches) declines to. Bounded, and the context is
    // thrown away afterwards, so nothing needs restoring.
    const tabs = await tab.locator('role=tab').all();
    for (const [index, group] of tabs.slice(0, NAV_TAB_LIMIT).entries()) {
      const label = ((await group.innerText().catch(() => '')) || `tab ${index + 1}`)
        .replace(/\s+/g, ' ')
        .trim();
      try {
        if (!(await group.isVisible())) continue;
        await group.click({ timeout: 2_000 });
        await tab.waitForTimeout(NAV_TAB_SETTLE_MS);
      } catch {
        continue;
      }
      for (const node of await captureAxNodes(tab, 600)) {
        if (node.role === 'link' && node.url) keep(node.name, node.url, label);
      }
    }
    const nav: NavMap = {
      learnedAt: new Date().toISOString(),
      origin,
      as: options.credentials.email,
      links: [...links.values()],
    };
    log?.(`navigation map: read ${nav.links.length} destination(s) from the application's own menu`);
    const entry = await resolveRepo(slug);
    if (entry) await upsertRepo({ ...entry, nav });
    return nav;
  } catch (error) {
    log?.(`navigation map: ${error instanceof Error ? error.message : String(error)} — not read`);
    return undefined;
  } finally {
    await closeTab?.();
  }
}

/** How many ranked routes the journey capture will try before giving up. */
const JOURNEY_ROUTE_CANDIDATES = 5;

/**
 * Page URLs the request itself names, on the run's own origin, in the order
 * written — the sign-in page, a consent page and API paths excluded. Absolute
 * URLs first, then bare paths ("/en/workflows/probation").
 */
export function literalDestinations(text: string, startUrl: string): string[] {
  let origin: string;
  let startPath: string;
  try {
    const parsed = new URL(startUrl);
    origin = parsed.origin;
    startPath = parsed.pathname;
  } catch {
    return [];
  }
  const out: string[] = [];
  const keep = (path: string): void => {
    const clean = path.replace(/[.,;:!?)\]'"]+$/, '');
    if (
      clean.length <= 1 ||
      clean === startPath ||
      /^\/api\//i.test(clean) ||
      LOGIN_URL_PATTERN.test(clean) ||
      CONSENT_URL_PATTERN.test(clean)
    ) {
      return;
    }
    const url = origin + clean;
    if (!out.includes(url)) out.push(url);
  };
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>()\]]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?)\]'"]+$/, ''));
      if (url.origin === origin) keep(url.pathname);
    } catch {
      // not a URL after all
    }
  }
  for (const match of text.matchAll(/(?:^|[\s"'(])(\/[A-Za-z][A-Za-z0-9._~%-]*(?:\/[A-Za-z0-9._~%-]+)+)/g)) {
    keep(match[1] as string);
  }
  return out;
}

/**
 * Fill a route pattern's non-locale parameters from id-shaped tokens the
 * request mentions (EMP-0005, PB-001, RULE-TRV-002). Only such tokens: an
 * ordinary word substituted for `:id` would be a page this invented. Leaves
 * the pattern untouched when nothing fits, so `concreteRouteUrl` reports it.
 */
export function fillRouteIds(pattern: string, text: string): string {
  const ids = [...text.matchAll(/\b([A-Z]{2,}(?:-[A-Z0-9]+)*-?\d{2,})\b/g)].map((m) => m[1] as string);
  if (ids.length === 0) return pattern;
  let next = 0;
  return pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':') || segment.slice(1).toLowerCase() === 'locale') return segment;
      const id = ids[next];
      if (id === undefined) return segment;
      next += 1;
      return id;
    })
    .join('/');
}

async function captureJourneyTree(
  page: Page,
  options: CliOptions,
  graph: ProjectGraph | null,
  description: string,
  log?: ((line: string) => void) | undefined,
  /**
   * The part of the request that names WHERE it goes — a sheet's Menu column
   * and title — when the caller has it apart from the rest. Matched against
   * the application's own menu labels; the whole description is the fallback.
   */
  hints: { where?: string | undefined } = {},
): Promise<string | undefined> {
  // `--scope e2e` turns this on by itself. An end-to-end test whose
  // destination page was never read cannot be grounded in it: measured, 9 of 9
  // authoring runs without the journey tree handed the middle of the journey
  // to a `workflow` step, and 0 of 3 did with it. Asking for e2e and getting
  // an ungrounded journey would be the flag failing to mean anything.
  if (!options.captureJourney && options.scope !== 'e2e') return undefined;
  if (!options.captureJourney) {
    // Never silent: it is a navigation of someone's application that they did
    // not ask for by name, and they are owed the sentence saying which flag
    // asked for it.
    log?.('journey capture: on because --scope e2e — an end-to-end test needs the page it ends on');
  }
  if (graph === null || options.url === undefined) {
    log?.('journey capture: needs both --repo (for the routes) and a start url — skipped');
    return undefined;
  }

  // **A URL the request names outright outranks any ranking.** A test-case
  // row frequently says where it goes in so many words ("Go to
  // http://localhost:3000/en/admin/employees/EMP-0005/probation"), and that
  // is evidence, not a guess — the BM25 ranking below is for the rows that
  // only say "Team → Probation Reviews". Measured before this: PB_01_01's row
  // named its page in step 2 and the ranker chose `…/:id/change-type` from
  // the same words, which needed an id and was skipped.
  const startRoute = findRouteForUrl(graph, options.url);
  const literal = literalDestinations(description, options.url);
  let resolved: { ok: true; url: string } | undefined;
  if (literal.length > 0) {
    resolved = { ok: true, url: literal[0] as string };
    log?.(`journey capture: the request names ${resolved.url} — reading it`);
  }
  // **The application's own menu, before any ranking over the code.** A
  // sheet says "Team → Probation Reviews"; the code says
  // `/:locale/workflows/probation`; only the deployed sidebar knows they are
  // the same place. Learned once per repository from a signed-in shell and
  // remembered on the registry entry — see `learnNavigationMap`.
  if (resolved === undefined && options.repo !== undefined) {
    const entry = await resolveRepo(options.repo);
    let origin: string | undefined;
    try {
      origin = new URL(options.url).origin;
    } catch {
      origin = undefined;
    }
    let nav = entry?.nav && entry.nav.origin === origin ? entry.nav : undefined;
    if (nav === undefined && entry && !navLearnedThisProcess.has(entry.slug)) {
      navLearnedThisProcess.add(entry.slug);
      nav = await learnNavigationMap(page, options, entry.slug, log);
    }
    const hit = navDestination(hints.where ?? description, nav);
    if (hit !== null && origin !== undefined) {
      resolved = { ok: true, url: origin + hit.path };
      log?.(
        `journey capture: the application's menu names "${hit.label}" → ${hit.path}` +
          (hit.via ? ` (behind "${hit.via}")` : '') +
          ' — reading it',
      );
    }
  }
  if (resolved === undefined) {
    const candidates = routesForDescription(graph, description, JOURNEY_ROUTE_CANDIDATES).filter(
      (route) => route.id !== startRoute?.id && route.meta?.['type'] !== 'api',
    );
    if (candidates.length === 0) {
      log?.('journey capture: no indexed route matches the description — skipped');
      return undefined;
    }
    // Best-ranked FIRST, and the first that resolves to a real URL. A pattern
    // that needs an id takes one the request itself mentions (EMP-0005,
    // PB-001 — an id-shaped token in the row's own words), else the next
    // candidate is tried. One page is read either way: a second doubles the
    // navigation on someone else's application for a diminishing return —
    // the call `page-probe.ts` makes about a second level of disclosure.
    const skipped: string[] = [];
    for (const route of candidates) {
      const attempt = concreteRouteUrl(fillRouteIds(route.name, description), options.url);
      if (attempt.ok) {
        resolved = attempt;
        break;
      }
      skipped.push(`${route.name}: ${attempt.reason}`);
    }
    if (resolved === undefined) {
      log?.(`journey capture: no candidate route resolves to a page — ${skipped[0] ?? 'skipped'}`);
      return undefined;
    }
  }

  let extra: Page | undefined;
  let closeExtra: (() => Promise<void>) | undefined;
  let landingAfterSignIn: string | undefined;
  try {
    ({ tab: extra, close: closeExtra } = await openCaptureTab(page));
    // **Sign in first whenever credentials allow it, whether or not the
    // destination would have demanded it.** Two reasons, both measured on an
    // application whose routes are not guarded server-side: an unsigned tab
    // reads the page in a rendering the flow will never see (the flow signs
    // in), and a capture that never signs in never observes where the
    // application lands a signed-in user — the one piece of evidence that
    // stops the author guessing a landing path, which four cases in one run
    // did, identically, and failed on for 10 seconds each.
    if (
      options.credentials &&
      shouldSignInForCapture({ landedUrl: options.url, credentials: options.credentials, alreadyTried: false })
    ) {
      await extra.goto(options.url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      if (LOGIN_URL_PATTERN.test(extra.url())) {
        log?.(`journey capture: signing in as ${options.credentials.email} first…`);
        const outcome = await signInOnCaptureTab(extra, options.credentials);
        if (outcome.ok && !LOGIN_URL_PATTERN.test(extra.url())) landingAfterSignIn = extra.url();
      }
    }
    log?.(`journey capture: reading ${resolved.url}…`);
    await extra.goto(resolved.url, { waitUntil: 'domcontentloaded' });
    await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    // A gate in the way of the destination is passed, whoever signed in.
    if (await passConsentGate(extra)) {
      await extra.goto(resolved.url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    }
    let landed = extra.url();
    if (LOGIN_URL_PATTERN.test(landed)) {
      if (
        !shouldSignInForCapture({
          landedUrl: landed,
          credentials: options.credentials,
          alreadyTried: false,
        })
      ) {
        log?.(
          `journey capture: ${journeyCaptureNote({ kind: 'no-session', target: resolved.url, landed })}`,
        );
        return undefined;
      }

      // Announced, because it is an action taken on someone's application.
      // A sign-in this performed and did not mention would be indefensible.
      const credentials = options.credentials as { email: string; password: string };
      log?.(`journey capture: signing in as ${credentials.email} to reach ${resolved.url}…`);
      const outcome = await signInOnCaptureTab(extra, credentials);
      if (!outcome.ok) {
        log?.(`journey capture: ${journeyCaptureNote(outcome.reason)}`);
        return undefined;
      }

      // Where the application put the signed-in user, before this navigates
      // away: real evidence for the one assertion the author otherwise has to
      // guess — "prove the sign-in took". Measured, without it the author
      // asserted /en/admin, /en/home and /en/employees for three personas from
      // route names alone, and any of those wrong is a blocked case.
      landingAfterSignIn = extra.url();
      await extra.goto(resolved.url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      landed = extra.url();
      if (LOGIN_URL_PATTERN.test(landed)) {
        log?.(
          `journey capture: ${journeyCaptureNote({ kind: 'sign-in-refused', email: credentials.email, landed })}`,
        );
        return undefined;
      }
    }

    const tree = await captureAxTree(extra, DEFAULT_AUTHOR_MAX_NODES);
    if (tree.trim() === '') {
      log?.(`journey capture: ${landed} yielded an empty tree — skipped`);
      return undefined;
    }
    log?.(`journey capture: read ${landed}`);
    const landing =
      landingAfterSignIn === undefined ||
      LOGIN_URL_PATTERN.test(landingAfterSignIn) ||
      CONSENT_URL_PATTERN.test(landingAfterSignIn)
        ? ''
        : `SIGN-IN LANDING (observed): after signing in as ${(options.credentials as { email: string }).email}` +
          ` — and passing the consent gate, when one appeared — the application landed on ${landingAfterSignIn}. ` +
          'This is the ONLY landing path you may expectUrl, and only for that same account; any ' +
          'other persona\'s landing is unknown, so its proof of sign-in is expectHidden of the ' +
          'submit control (see SIGNING IN), never a path inferred from a route or role name.\n\n';
    return (
      landing +
      `ANOTHER PAGE IN THIS JOURNEY — the accessibility tree of ${landed}, which the request ` +
      'describes. It is NOT the page this run starts on: a selector taken from here resolves ' +
      'only after the flow has navigated to that page, so write the goto or the click that ' +
      `reaches it first.\n\n${tree}`
    );
  } catch (error) {
    // Diagnostic, and swallowed: authoring without this section is exactly
    // what authoring did before it existed.
    log?.(
      `journey capture: ${error instanceof Error ? error.message : String(error)} — authoring ` +
        'proceeds with the start page alone',
    );
    return undefined;
  } finally {
    // The capture ran in a context of its own (`openCaptureTab`); closing it
    // is the whole cleanup, and nothing it did can reach the runs that follow.
    await closeExtra?.();
  }
}

export async function cmdCatalog(file: string | undefined, options: CliOptions): Promise<number> {
  if (!file) {
    process.stderr.write('wowlidator catalog: missing "<file>"\n');
    return 2;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator catalog: ${gate}\n`);
    return EXIT.environment;
  }

  // `--repo` is validated up front, not only where phase 2 loads the graph —
  // otherwise `--claims-only --repo bogus` neither uses nor rejects the flag,
  // and the "unknown selection fails loudly" contract quietly has a gap.
  const repoEntry = options.repo === undefined ? null : await resolveRepo(options.repo);
  if (options.repo !== undefined && repoEntry === null) {
    process.stderr.write(
      `wowlidator catalog: unknown repository "${options.repo}" — see saved ones with: wowlidator context list\n`,
    );
    return 2;
  }

  const log = lineLogger(options);

  // Documents remembered WITH the repository ride along automatically — that
  // is what remembering them was for. Per-run `--context-doc` files come
  // first (this invocation's word wins the reading order), remembered ones
  // follow, deduplicated by resolved path so a document both remembered and
  // passed is read once. Read fresh from disk here, so an updated file is
  // its own update.
  const contextDocPaths = [...options.contextDocs];
  for (const remembered of repoEntry?.contextDocs ?? []) {
    if (!contextDocPaths.some((doc) => resolve(doc) === remembered)) {
      contextDocPaths.push(remembered);
      log?.(`context: reading ${remembered.split('/').pop()} — remembered with ${repoEntry!.slug}`);
    }
  }

  // --- the document, and its supporting cast --------------------------------
  let document;
  const contextDocs = [];
  let transcriptionNote = '';
  try {
    // An image of a sequence diagram gets one model step in front of the
    // ordinary path: a vision transcription to Mermaid, written to disk next
    // to the image so the gate can include diffing it against the drawing.
    // Everything downstream — parse, lanes, claims, authoring — then cites
    // the transcript, byte-for-byte the file a person can correct and re-run.
    let sourceFile = resolve(file);
    if (isDiagramImage(sourceFile)) {
      const transcriptPath = `${sourceFile}.transcribed.mmd`;
      // Sticky: the claims gate and the run must read the SAME transcript. A
      // second vision call between the two phases could read the pixels
      // differently, and the person would have approved claims about a
      // diagram that was then re-invented. Delete the file to re-transcribe.
      //
      // Sticky is keyed on the image being UNCHANGED, not on the file merely
      // existing: replacing the image under the same name while an old
      // transcript sits beside it would silently run approved claims about a
      // drawing that no longer exists. An image newer than its transcript is
      // re-transcribed, and says so.
      let existing: string | null = null;
      try {
        existing = await readFile(transcriptPath, 'utf8');
        const [imageStat, transcriptStat] = await Promise.all([
          stat(sourceFile),
          stat(transcriptPath),
        ]);
        if (imageStat.mtimeMs > transcriptStat.mtimeMs) {
          log?.(
            `${file} changed after its transcript was written — transcribing the new image (the old ${transcriptPath} is replaced)`,
          );
          existing = null;
        }
      } catch {
        existing = null;
      }
      if (existing !== null) {
        log?.(`reusing ${transcriptPath} — the transcript already reviewed at the gate; delete it to transcribe the image again`);
        // The transcript carries its own disclosure header (a `%%` Mermaid
        // comment the parser skips), so the "a model read pixels" warning —
        // including what it could not read — survives into every later phase,
        // not just the run that transcribed.
        const header = /^%% (.+)$/m.exec(existing);
        transcriptionNote =
          header?.[1] ??
          `transcribed earlier from ${file} — the run reads the reviewed .transcribed.mmd, not the image`;
      } else {
        const transcribed = await transcribeDiagramImage(
          sourceFile,
          new LlmDiagramTranscriber({ factory: options.factory }),
          log ?? undefined,
        );
        await writeFile(transcriptPath, `%% ${transcribed.note}\n${transcribed.mermaid}\n`, 'utf8');
        log?.(`transcript written to ${transcriptPath} — edit it there if the model misread the image; later phases reuse it as written`);
        // The vision call is paid work and reports like every other model
        // call — a summary that said "no model call" about a run that spent
        // tokens reading pixels would be the panel lying about cost.
        process.stdout.write(
          `  transcription  ${transcribed.inputTokens} in / ${transcribed.outputTokens} out tokens\n`,
        );
        transcriptionNote = transcribed.note;
      }
      sourceFile = transcriptPath;
    }
    document = await extractDocumentFile(sourceFile);
    if (transcriptionNote !== '') {
      document.note = document.note === '' ? transcriptionNote : `${document.note}; ${transcriptionNote}`;
    }
    for (const path of contextDocPaths) {
      // The whole document, not its first `DEFAULT_MAX_CHARS`. Extraction
      // truncates *positionally*, so a longer spec's last sections were
      // unreachable by every consumer, silently. Once relevance decides what
      // is sent, position no longer has to. With the budget off the old cap
      // applies again: an unbounded document sent whole is the one combination
      // this must not produce.
      contextDocs.push(
        await extractDocumentFile(
          resolve(path),
          options.contextBudget > 0 ? CONTEXT_DOC_MAX_CHARS : undefined,
        ),
      );
    }
  } catch (error) {
    process.stderr.write(
      `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  log?.(
    `read ${document.name} (${document.format}, ${document.originalChars.toLocaleString('en-US')} chars)` +
      (contextDocs.length > 0 ? ` + ${contextDocs.length} context document(s)` : ''),
  );
  // Never a log line only: an approximation the reader does not see is an
  // approximation that reaches the model unchallenged.
  if (document.note !== '') process.stdout.write(`  ! ${document.name}: ${document.note}\n`);
  for (const context of contextDocs) {
    if (context.note !== '') process.stdout.write(`  ! ${context.name}: ${context.note}\n`);
  }

  // Is this the project's own catalog format? If so its columns already say
  // everything the extractor would have to infer, so it is read rather than
  // interpreted — no model call, no lost Test Case IDs, nothing invented. See
  // `src/catalog/test-case-table.ts`.
  let table: TestCaseRow[] | null = null;
  if (document.format === 'csv') {
    try {
      table = parseTestCaseTable(await readFile(resolve(file), 'utf8'));
    } catch {
      table = null;
    }
  }
  if (table !== null) {
    log?.(`${document.name} is a test-case table — ${table.length} case(s), read from its columns`);
  }

  // A sequence diagram is structured the way a table is: read, not
  // interpreted. One claim per message, plane defaults classified
  // deterministically, and every guess written into the claims file for the
  // gate to confirm rather than acted on. No model call.
  let sequence: SequenceDoc | null = null;
  if (document.format === 'sequence') {
    try {
      sequence = parseSequenceDiagram(document.text);
    } catch (error) {
      // `extractDocumentFile` already validated the parse, so getting here
      // means the two passes disagree — surface it rather than guessing.
      process.stderr.write(
        `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }

  // --- phase 1: what does this document claim? ------------------------------
  let claimsFile: ClaimsFile;
  if (options.claims !== undefined) {
    try {
      claimsFile = parseClaimsFile(await readFile(resolve(options.claims), 'utf8'));
    } catch (error) {
      process.stderr.write(
        `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
    // Re-derive testability from the lane table the file itself carries, so a
    // plane corrected by hand in the JSON takes effect here exactly as it
    // does in the panel's lane editor — and so a lane correction that makes
    // the browser the claimed caller of server-side traffic is warned about
    // rather than silently manufacturing claims that must fail.
    const recompute = recomputeLaneTestability(claimsFile);
    if (recompute.changed > 0) {
      log?.(
        `lane table recomputed ${recompute.changed} claim(s) — testability follows the planes in ${options.claims}`,
      );
    }
    for (const warning of recompute.warnings) {
      process.stdout.write(`  ! ${warning}\n`);
    }
    log?.(`read ${approvedClaims(claimsFile).length} approved claim(s) from ${options.claims}`);
  } else if (table !== null) {
    // Free and exact: one claim per row, keyed to its Test Case ID.
    claimsFile = toClaimsFile(
      document.name,
      {
        summary: `${table.length} test case(s) across ${new Set(table.map((row) => row.scenarioId)).size} scenario(s)`,
        claims: tableToClaims(table),
        model: 'read from the sheet (no model call)',
        latencyMs: 0,
        documentNote: document.note,
      },
      new Date().toISOString(),
    );
    process.stdout.write(
      `read ${claimsFile.claims.length} claim(s) from ${document.name}\n` +
        `  format     test-case table — columns read directly, no model call\n` +
        `  summary    ${claimsFile.summary}\n`,
    );
  } else if (sequence !== null) {
    // Free and exact, the table path one notch up in structure: one claim per
    // message. Lanes past the browser boundary come out testable:false with
    // the boundary named — kept, shown, never checked.
    const derived = sequenceToClaims(sequence);
    // Claims derivation is deterministic either way, but an image-sourced
    // diagram DID pay a vision call to become text — a model string reading
    // "no model call" there would misstate what this run cost and hid.
    const claimsModel =
      transcriptionNote === ''
        ? 'read from the diagram (no model call)'
        : 'read from the transcript (deterministic) — the transcript itself is a model reading of the image';
    claimsFile = toClaimsFile(
      document.name,
      {
        summary: derived.summary,
        claims: derived.claims,
        model: claimsModel,
        latencyMs: 0,
        documentNote: document.note,
      },
      new Date().toISOString(),
      // The whole gate info, message mapping included — it is what lets the
      // panel's lane editor recompute testability when a plane is corrected.
      toGateInfo(sequence),
    );
    process.stdout.write(
      `read ${claimsFile.claims.length} claim(s) from ${document.name}\n` +
        `  format     sequence diagram (${sequence.notation}) — ` +
        (transcriptionNote === ''
          ? 'messages read directly, no model call\n'
          : 'messages read from the model-transcribed .mmd; review it against the image\n') +
        `  summary    ${claimsFile.summary}\n`,
    );
    // The participant table is the gate's new column. A guessed plane decides
    // which claims are checkable, so it is shown here and stored in the
    // claims file — confirm or correct it there before running.
    for (const participant of sequence.participants) {
      process.stdout.write(
        `  lane       ${participant.id} (${participant.label}) — ${participant.plane}` +
          `${participant.guessed ? '   (guessed — confirm in the claims file)' : ''}\n`,
      );
    }
  } else {
    log?.('asking the generator role what this document claims…');
    // The query is the catalog's own text: what background bears on THIS
    // document. Only the supporting documents are selected over — the catalog
    // goes whole, because a claim nobody retrieved is a requirement silently
    // dropped, and the run would still report green.
    const forClaims = selectRelevantContext(contextDocs, document.text, {
      budgetChars: options.contextBudget,
      onWarn: (line) => process.stderr.write(`  ! ${line}\n`),
    });
    if (forClaims.note !== '') log?.(forClaims.note);
    const model = new LlmCatalogModel({ factory: options.factory });
    let claims;
    try {
      claims = await extractClaims(model, {
        document,
        context: forClaims.documents,
        maxClaims: options.maxClaims,
      });
    } catch (error) {
      process.stderr.write(
        `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    claimsFile = toClaimsFile(document.name, claims, new Date().toISOString());
    process.stdout.write(
      `read ${claimsFile.claims.length} claim(s) from ${document.name}\n` +
        `  model      ${claims.model} (${claims.latencyMs}ms, ${claims.inputTokens ?? 0} in / ${claims.outputTokens ?? 0} out tokens)\n` +
        `  summary    ${claims.summary}\n`,
    );
  }

  const claimsPath =
    options.claimsOut === undefined
      ? join(resolve(options.reportDir), 'catalogs', `${slugify(document.name)}.claims.json`)
      : resolve(options.claimsOut);

  if (options.claims === undefined) {
    await mkdir(resolve(claimsPath, '..'), { recursive: true });
    await writeFile(claimsPath, `${JSON.stringify(claimsFile, null, 2)}\n`, 'utf8');
    process.stdout.write(`  claims     ${claimsPath}\n`);
    for (const claim of claimsFile.claims) {
      process.stdout.write(
        `    ${claim.testable ? '·' : ' '} [${claim.priority}] ${claim.claim}${claim.testable ? '' : '   (context, not checked)'}\n`,
      );
    }
  }

  if (options.claimsOnly) {
    process.stdout.write(
      '\nNothing has been run. Strike out anything you do not want by setting ' +
        '"approved": false, then:\n' +
        `  wowlidator catalog ${file} --claims ${claimsPath} --url <page> --run\n`,
    );
    return 0;
  }

  // --- phase 2: claims → steps → a run --------------------------------------
  const approved = approvedClaims(claimsFile).filter((claim) => claim.testable);
  if (approved.length === 0) {
    process.stderr.write(
      'wowlidator catalog: no approved, testable claims — nothing to prove.\n',
    );
    return 2;
  }

  const blocked = await prepare(options, options.url);
  if (blocked !== null) return blocked;

  let repoContextGraph: ProjectGraph | null = null;
  try {
    repoContextGraph = await loadRepoGraph(options, log ?? undefined);
  } catch (error) {
    process.stderr.write(`wowlidator catalog: ${(error as Error).message}\n`);
    return 2;
  }
  // The claims are what this catalog is about, so they decide which tables are
  // worth offering — same narrowing as the describe path, same reason.
  const tables = await tableInventory(
    repoContextGraph,
    approved.map((claim) => claim.claim).join('\n'),
    log ?? undefined,
  );
  if (tables.length > 0) {
    log?.(`schema indexed — ${tables.length} table(s) available for DB checks`);
  } else if (
    approved.some((claim) => /\b(sql|database|db|psql|postgres|row|table|column)\b/i.test(claim.claim))
  ) {
    // Loud, not a log line: with no schema indexed the author structurally
    // CANNOT emit a DB check, so a database claim silently degrades to UI
    // text proxies and a green run overstates what was proven — seen live as
    // a "health counts match the database exactly" case that never read a
    // single count. The degradation still happens (the claims may have a
    // checkable UI half); it must never happen silently.
    process.stdout.write(
      '  ! these claims assert database state, but no schema is indexed — DB checks cannot ' +
        'be authored and the cases degrade to what the UI alone shows. Index one with: ' +
        'wowlidator context add <app repo> --db-schema <schema.sql> (or set WOWLIDATOR_DB_URL ' +
        'for live introspection) and pass --repo.\n',
    );
  }
  // What this catalog is about, in the document's own words — the same text
  // the claims were read out of. A catalog names its journey as surely as a
  // typed description does, so it seeds the same route lookup.
  const catalogDescription = [claimsFile.summary, ...approved.map((claim) => claim.claim)]
    .filter((line) => line !== '')
    .join('\n');
  const projectContext = repoPromptSection(
    repoContextGraph,
    options.url,
    log ?? undefined,
    catalogDescription,
  );
  const reviewer = buildFlowReviewer(options);
  const author = new FlowAuthor({
    model: new LlmFlowAuthorModel({ factory: options.factory }),
    policy: options.policy,
    probe: options.probe,
    ...(reviewer === null ? {} : { reviewer }),
    ...(tables.length > 0 ? { tables } : {}),
    ...(projectContext !== '' ? { projectContext } : {}),
    // The third grounding source for expectUrl. A route the application
    // declares is evidence as good as the tree's own url= attributes.
    declaredRoutes: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'route')
      .map((node) => node.name),
    // The same grounding, one layer down: `METHOD /path` for every endpoint
    // the repo declares, so an authored request's METHOD can be checked —
    // see `unindexedRequestMethod`.
    declaredOperations: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'operation')
      .map((node) => node.name),
    // The run's own backend toggle. Off, no HTTP or database step is written
    // and the claims are proved through the page with a note — see
    // `FlowAuthorOptions.backend`.
    backend: options.backend,
    // Supplied by the person, never guessed — see `parseCredentials`.
    ...(options.credentials ? { credentials: options.credentials } : {}),
    // `--scope e2e` was silently ignored on this path: the flag was read into
    // the options and never handed to the catalog's author, so a catalog of
    // end-to-end rows was authored as unit tests of the login page.
    scope: options.scope,
    onLog: log,
  });

  // A table row carries the steps a tester would take and what each should
  // produce, keyed step-by-step. That is strictly more than the claim sentence
  // the general path distils it into, so when the rows are there the author gets
  // them — the difference between a model inventing a journey and being told it.
  const approvedIds = new Set(approvedClaims(claimsFile).map((claim) => claim.source));
  const allRows = table === null ? [] : table.filter((row) => approvedIds.has(row.caseId));
  // `--resume`: the progress ledger beside the claims file says which cases
  // already have a verdict; only the ones that never ran, or were never
  // reached, are authored and run again. Stated out loud, with the counts,
  // because "108 planned, 36 skipped, 72 to run" is the whole point.
  // The pass stamp every case of this catalog is grouped by. A resume takes
  // the ORIGINAL pass's stamp from the ledger, so its cases join the group
  // the first run opened instead of starting a second one for the same
  // catalog — the stamp identifies the approved list, not the process.
  // Minted HERE, at initialisation, not lazily from the first authored flow:
  // the run key below is built on it, and a run that dies while authoring its
  // first case must still have left a keyed ledger behind.
  const passStamp: { value: string | null } = { value: new Date().toISOString() };
  // The catalog run's unique key: the catalog's name plus the pass stamp.
  // A resume reads the stored key from the prior ledger and keeps it, so one
  // approved list answers to one key across every pause and continue — and
  // the cases an earlier pass finished are pulled in under it as finished
  // tests rather than lost to the resumed subset.
  const storedRunKey: { value: string | null } = { value: null };
  const runKeyOf = (): string => storedRunKey.value ?? `${slugify(document.name)}@${passStamp.value}`;
  // The ledger is kept whenever there is anything to key it on — the claims
  // file just written counts, so a first pass (`catalog file.csv --run`, no
  // --claims yet) is resumable too, not only a re-run of a reviewed file.
  const ledgerClaimsPath = options.claims === undefined ? claimsPath : resolve(options.claims);
  const ledgerSpec =
    options.claims === undefined && allRows.length === 0
      ? undefined
      : {
          path: ledgerPathFor(ledgerClaimsPath),
          planned: allRows.map((r) => r.caseId),
          resume: options.resume,
          stamp: () => passStamp.value,
          runKey: () => runKeyOf(),
          // Enough to rebuild a resume after this process — and the panel
          // that may have spawned it — are gone. The password (`--as`) rides
          // env on purpose and is deliberately NOT recorded.
          launch: {
            catalog: resolve(file),
            claims: ledgerClaimsPath,
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.repo === undefined ? {} : { repo: options.repo }),
          },
        };
  let rows = allRows;
  if (options.resume) {
    const prior = ledgerSpec === undefined ? null : await readLedger(ledgerSpec.path);
    // `--rerun-vacuous`: every recorded case whose flow on disk asserts
    // nothing about its claim is marked blocked in the ledger — a vacuous
    // pass was never a verdict — and the resume below picks it up.
    if (prior !== null && ledgerSpec !== undefined && options.rerunVacuous) {
      const marked = await markVacuous(prior, async (flowPath) => {
        try {
          const flow = JSON.parse(await readFile(flowPath, 'utf8')) as { setup?: unknown; steps?: unknown };
          return vacuousFlow(flow as never);
        } catch {
          return null;
        }
      });
      await writeLedger(ledgerSpec.path, prior);
      log?.(
        marked.length === 0
          ? '--rerun-vacuous: no recorded case has a vacuous flow'
          : `--rerun-vacuous: ${marked.length} recorded case(s) proved nothing about their claim and will be re-authored: ${marked.join(', ')}`,
      );
    }
    // `--rerun-errors`: cases the HARNESS ended (an error bundle, or none)
    // are not verdicts about the application and get another run.
    // `--rerun-failed`: the failed and dead-end cases go again, with autoheal
    // on (the flag implies --repair) — a second look at the flow, not a
    // claim that the application changed.
    // `--resume-from <caseId>`: run again from that case ONWARD in plan order
    // — verdicts before it are kept, everything at or after it (whatever its
    // verdict, passes included) runs again. A fresh process, so the rerun
    // takes whatever `.env` and the code say NOW — the way to re-run the tail
    // of a paused suite under a new model or config. Case granularity on
    // purpose: a case restarts from its own first step, because a browser's
    // mid-case state cannot be resurrected.
    if (prior !== null && ledgerSpec !== undefined && options.resumeFrom) {
      const at = prior.planned.indexOf(options.resumeFrom);
      const start = at >= 0 ? at : prior.planned.findIndex((id) => id.startsWith(options.resumeFrom!));
      if (start < 0) {
        process.stderr.write(
          `wowlidator catalog: --resume-from "${options.resumeFrom}" matches no planned case. Planned ids: ${prior.planned.slice(0, 8).join(', ')}${prior.planned.length > 8 ? ', …' : ''}\n`,
        );
        return EXIT.usage;
      }
      const tail = new Set(prior.planned.slice(start));
      const marked = markForRerun(prior, (_o, id) => tail.has(id), `resume-from ${prior.planned[start]}`);
      await writeLedger(ledgerSpec.path, prior);
      log?.(
        `--resume-from: rerunning from ${prior.planned[start]} — ${marked.length} recorded case(s) rerun, ` +
          `${start} before it keep their verdicts; the rerun uses the current config`,
      );
    }
    if (prior !== null && ledgerSpec !== undefined && (options.rerunErrors || options.rerunFailed)) {
      const errors = options.rerunErrors ? markForRerun(prior, isErrorOutcome, 'rerun after error') : [];
      const failed = options.rerunFailed ? markForRerun(prior, isFailedOutcome, 'heal: re-run with autoheal') : [];
      await writeLedger(ledgerSpec.path, prior);
      if (options.rerunErrors) log?.(errors.length === 0 ? '--rerun-errors: no recorded case ended in error' : `--rerun-errors: ${errors.length} case(s) the harness ended will run again: ${errors.join(', ')}`);
      if (options.rerunFailed) log?.(failed.length === 0 ? '--rerun-failed: no recorded case failed' : `--rerun-failed: ${failed.length} failed case(s) will run again with autoheal: ${failed.join(', ')}`);
    }
    if (prior?.generatedAt) {
      passStamp.value = prior.generatedAt;
      log?.(`--resume: cases join the pass authored at ${prior.generatedAt}`);
    }
    // The stored key outranks a re-derived one: the run's identity was fixed
    // when the run was initialised, and a resume continues that run.
    if (prior?.runKey) storedRunKey.value = prior.runKey;
    if (prior === null) {
      log?.(`--resume: no progress ledger at ${ledgerSpec?.path ?? '(no --claims file)'} — running everything`);
    } else {
      const left = new Set(remaining(prior, allRows.map((r) => r.caseId)));
      rows = allRows.filter((row) => left.has(row.caseId));
      const s = summariseLedger(prior);
      log?.(
        `--resume: ${s.planned} planned — ${s.passed} passed, ${s.failed} failed${s.review > 0 ? `, ${s.review} proved-?` : ''} already have verdicts and are skipped; ` +
          `${rows.length} to run (${s.blocked} never ran, ${s.notReached} never reached)` +
          (prior.ended?.cause ? ` — the last run stopped: ${prior.ended.cause}` : ''),
      );
      if (rows.length === 0) {
        process.stdout.write('nothing left to run — every planned case has a verdict\n');
        return EXIT.ok;
      }
    }
  }

  // Announced once, at initialisation: this is the name under which the run —
  // and any later resume of it — appears in the record's run list.
  if (ledgerSpec !== undefined) {
    log?.(`catalog run key ${runKeyOf()} — a resume continues this same run under it`);
  }

  let authored: AuthoredFlow;
  let tableCases: TableCase[] = [];
  // One provenance for the whole pass, from its first authored flow: the
  // same stamp whichever path writes it, so every case groups together.
  const provenanceOf = (first: AuthoredFlow): GenerationProvenance => ({
    model: first.model,
    generatedAt: (passStamp.value ??= first.authoredAt),
    sourceUrl: first.sourceUrl ?? `catalog: ${document.name}`,
    kind: 'catalog',
    rationale: claimsFile.summary || first.rationale,
    source: document.name,
    runKey: runKeyOf(),
  });
  // Where the pass's artifacts land — the same rule `dir`/`group` below
  // apply once authoring is done, needed earlier by the pipelined path.
  const placeFor = (first: AuthoredFlow): { group: string | undefined; dir: string } => {
    const g = first.sourceUrl === undefined ? undefined : reportGroupForUrl(first.sourceUrl);
    return { group: g, dir: g === undefined ? resolve(options.reportDir) : pageDir(options, g) };
  };
  try {
    if (rows.length > 0) {
      // Say which kind of test these rows become. A 'Test Script / Steps'
      // column IS the script — each row is a unit test of the screen its
      // steps land on, and only an explicit --scope e2e turns the journey
      // demands (notEndToEnd, forced journey capture) on. Said out loud
      // because the difference decides which refusals can fire, and a person
      // reading "dead-end" needs to know which contract the flow was held to.
      log?.(
        options.scope === 'e2e'
          ? `rows author as END-TO-END journeys (--scope e2e): each must travel and verify on the page it reaches`
          : `rows author as UNIT tests (their Steps column is the script; scope ${options.scope}) — pass --scope e2e to demand full journeys`,
      );
      // **A row is a case. Not a suggestion to the model — the unit itself.**
      //
      // Asking for one flow and letting the model divide it read a 12-row sheet
      // and came back with one task: it is free to group, and grouping is what
      // it does. But the sheet already drew the lines, and they are the lines
      // the person who wrote it meant. So each row is authored on its own and
      // the count out equals the count in, by construction rather than by
      // instruction — the same reason `MutationPolicy` is a filter and not a
      // sentence in a prompt.
      //
      // The cost is one authoring call per row against one open page. That is
      // the price of the guarantee, and it is the guarantee that was asked for.
      // **A case runs the moment it is written, when the pool allows more
      // than one.** Authoring a row is a model call the browser spends idle;
      // running a case is browser time the model spends idle. With
      // `--run` and a concurrency above 1 the two overlap: each authored
      // case is stamped, written to disk and pushed into a `CaseQueue` that
      // `runCases` is already draining, so the first case is usually proved
      // before the last row is authored. Concurrency 1 keeps the old order —
      // author everything, then run — which is also the A/B for a pipelined
      // result that looks wrong. The queue is closed in a `finally`: a
      // refused row or a thrown authoring must never leave runs waiting on
      // a list that will not grow.
      const pipelined =
        options.run && Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY) > 1;
      const queue = pipelined ? new CaseQueue<SuiteCase>() : null;
      const drain: { value: Promise<CaseOutcome[]> | null } = { value: null };
      const placed: { value: { group: string | undefined; dir: string } | null } = { value: null };
      if (queue !== null) {
        log?.(`cases will run as they are authored (pipelined; --concurrency 1 authors everything first)`);
      }
      // Authoring holds to the scenario the runner is in — a row of scenario
      // N+1 is not authored while scenario N still has cases running. Only on
      // the pipelined path: a run that starts after the last row would
      // deadlock a gate that waits on runs. `--author-lookahead all` restores
      // the old eager behaviour; a number widens the window by that many
      // scenarios.
      const gate =
        queue === null || options.authorLookahead === 'all'
          ? null
          : new ScenarioGate(
              rows.map((row) => row.scenarioId || 'ungrouped'),
              { lookahead: typeof options.authorLookahead === 'number' ? options.authorLookahead : 0 },
            );
      if (gate !== null) {
        log?.('authoring keeps pace with the runs: a scenario is authored only once every scenario before it has finished running (--author-lookahead widens this)');
      }
      // The healer repairs with the same retrieved context the author reads:
      // the repository's declarations for the failing page, and the
      // background documents ranked by the failed step's own words.
      const suiteHealHints = healHintsFrom(repoContextGraph ?? null, contextDocs);
      const queuedPaths: string[] = [];
      try {
        const authoredRows = await authorEachRow(rows, author, options, {
          summary: claimsFile.summary,
          context: contextDocs,
          log,
          graph: repoContextGraph,
          gate,
          onCase:
            queue === null
              ? undefined
              : async (testCase, first) => {
                  // The report folder is known from the first authored flow,
                  // and the consumer starts then: nothing is queued before
                  // there is somewhere for its report to go.
                  placed.value ??= placeFor(first);
                  const { group, dir } = placed.value;
                  drain.value ??= runCases(queue, options, {
                    dir,
                    group,
                    indexTitle: `wowlidator catalog — ${document.name}`,
                    ledger: ledgerSpec,
                    healHints: suiteHealHints,
                    onCaseDone: (finished) => {
                      if (finished.scenarioId !== undefined) gate?.ran(finished.scenarioId);
                    },
                  });
                  // Same stamp and same file the non-pipelined path writes
                  // below — built here because the run needs both now.
                  testCase.flow.authoredBy = {
                    ...provenanceOf(first),
                    scenario: testCase.scenario,
                    caseTitle: testCase.caseTitle,
                    ...(testCase.knownResult === undefined ? {} : { knownResult: testCase.knownResult }),
                  };
                  const flowPath = await writeFlowFile(
                    catalogFlowPath(options, {
                      dir: join(dir, slugify(testCase.scenarioId)),
                      group,
                      name: testCase.flow.name,
                      index: rows.length === 1 ? undefined : queuedPaths.length + 1,
                    }),
                    testCase.flow,
                  );
                  queuedPaths.push(flowPath);
                  log?.(`  queued ${testCase.name} → ${flowPath}`);
                  queue.push({
                    name: testCase.name,
                    flow: testCase.flow,
                    flowPath,
                    kind: 'catalog',
                    scenarioId: testCase.scenarioId,
                    ...(group === undefined ? {} : { group: `${group}/${slugify(testCase.scenarioId)}` }),
                    generatedBy: testCase.flow.authoredBy,
                  });
                  gate?.queued(testCase.scenarioId);
                },
        });
        authored = authoredRows.first;
        tableCases = authoredRows.cases;
      } catch (error) {
        // Authoring broke; the cases already queued are still running and
        // still owed their reports. Let them finish before the error lands,
        // or they are abandoned mid-run with their proofs half-written.
        queue?.close();
        if (drain.value !== null) await drain.value.catch(() => undefined);
        throw error;
      } finally {
        queue?.close();
      }
      if (drain.value !== null && placed.value !== null) {
        printAuthored(authored, tableCases, queuedPaths, approved.length, placed.value.group, placed.value.dir);
        const outcomes = await drain.value;
        return suiteExit(outcomes);
      }
    } else {
      const approvedText = approvedClaims(claimsFile)
        .map((claim) => claim.claim)
        .join('\n');
      const forFlow = selectRelevantContext(contextDocs, approvedText, {
        budgetChars: options.contextBudget,
        onWarn: (line) => process.stderr.write(`  ! ${line}\n`),
      });
      if (forFlow.note !== '') log?.(forFlow.note);
      const prompt = buildAuthoringPrompt(approvedClaims(claimsFile), {
        summary: claimsFile.summary,
        context: forFlow.documents,
      });
      log?.(`writing a flow for ${approved.length} claim(s)…`);
      authored = options.url
        ? await withPage(options.cdp, async (page) => {
            log?.(`opening ${options.url}…`);
            await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
            const pilot = buildCapturePilot(options);
            if (pilot) await pilotCapture(page, pilot, log);
            return author.author(prompt, page);
          })
        : await author.author(prompt);
    }
  } catch (error) {
    if (error instanceof AuthoringError) {
      process.stderr.write(`wowlidator catalog: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const group =
    authored.sourceUrl === undefined ? undefined : reportGroupForUrl(authored.sourceUrl);
  // An ungrounded catalog has no page to be named after, so its cases land at
  // the top level of the report directory. Never the working directory: the
  // `grimval` wrapper runs the CLI from the engine's own checkout, so a catalog
  // of ten cases would leave ten flow files loose in it.
  const dir = group === undefined ? resolve(options.reportDir) : pageDir(options, group);

  // One flow per discrete case, each carrying the shared setup and teardown, so
  // a case stands on its own. That is what makes a failure survivable: the cases
  // after it are separate runs and still get answered. A body the model did not
  // divide is one case, and behaves exactly as it always did.
  // One task per row when the catalog was a table; otherwise the model's own
  // division of the single flow it wrote.
  const cases: (Pick<TableCase, 'name' | 'flow'> & Partial<TableCase>)[] =
    tableCases.length > 0 ? tableCases : caseFlows(authored);
  const flowPaths: string[] = [];
  // One provenance for the whole pass, stamped on every case's flow BEFORE it
  // is written and again carried on its run: the flow file outlives the run,
  // and a re-run or a repair of it has to land in this catalog's group rather
  // than among hand-written flows. (It was once stamped after the write, so
  // every file on disk lacked it and only the first run ever grouped.)
  const catalogProvenance = provenanceOf(authored);
  // The pass-wide provenance plus the two per-case facts a sheet states —
  // scenario and test-case title — so the run list can group by the former
  // and print the latter without re-reading the sheet.
  for (const testCase of cases) {
    testCase.flow.authoredBy = {
      ...catalogProvenance,
      ...(testCase.scenario === undefined ? {} : { scenario: testCase.scenario }),
      ...(testCase.caseTitle === undefined ? {} : { caseTitle: testCase.caseTitle }),
      ...(testCase.knownResult === undefined ? {} : { knownResult: testCase.knownResult }),
    };
  }
  for (const [index, testCase] of cases.entries()) {
    // A sheet groups its rows by scenario; the folder does the same, so twelve
    // cases land in six classes rather than one flat pile.
    const scenario = testCase.scenarioId;
    flowPaths.push(
      await writeFlowFile(
        catalogFlowPath(options, {
          dir: scenario === undefined ? dir : join(dir, slugify(scenario)),
          group,
          name: testCase.flow.name,
          index: cases.length === 1 ? undefined : index + 1,
        }),
        testCase.flow,
      ),
    );
  }

  printAuthored(authored, cases, flowPaths, approved.length, group, dir);

  if (!options.run) return 0;

  // Every case runs, even after one fails — same reasoning as `fillEach`, one
  // level up: a catalog answered halfway is far less useful than the whole
  // table, and the claims after a failure were approved by someone who is still
  // owed an answer about them. `runCases` also survives a case that *throws*,
  // which a failed case does not: see its note.
  const outcomes = await runCases(
    cases.map((testCase, index) => ({
      flowPath: flowPaths[index],
      name: testCase.name,
      flow: testCase.flow,
      kind: 'catalog',
      ...(testCase.scenarioId !== undefined && group !== undefined
        ? { group: `${group}/${slugify(testCase.scenarioId)}` }
        : {}),
      // The flow's own stamp, not the pass-wide one: it carries the scenario
      // and case title the run list groups and labels by.
      generatedBy: testCase.flow.authoredBy ?? catalogProvenance,
    })),
    options,
    {
      dir,
      group,
      indexTitle: `wowlidator catalog — ${document.name}`,
      ledger: ledgerSpec,
      healHints: healHintsFrom(repoContextGraph ?? null, contextDocs),
    },
  );

  return suiteExit(outcomes);
}

export async function cmdAuthor(prompt: string | undefined, options: CliOptions): Promise<number> {
  if (!prompt) {
    process.stderr.write('wowlidator author: missing "<prompt>"\n');
    return 2;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator author: ${gate}\n`);
    return EXIT.environment;
  }

  const blocked = await prepare(options, options.url);
  if (blocked !== null) return blocked;

  const log = lineLogger(options);

  let repoContextGraph: ProjectGraph | null = null;
  try {
    repoContextGraph = await loadRepoGraph(options, log ?? undefined);
  } catch (error) {
    process.stderr.write(`wowlidator author: ${(error as Error).message}\n`);
    return 2;
  }
  const tables = await tableInventory(repoContextGraph, prompt, log ?? undefined);
  if (tables.length > 0) {
    log?.(`schema indexed — ${tables.length} table(s) available for DB checks`);
  }
  const projectContext = repoPromptSection(
    repoContextGraph,
    options.url,
    log ?? undefined,
    prompt,
  );
  // Everything the author needs that does not depend on a page. The journey
  // capture does, so the author itself is built inside `withPage` below — a
  // second tree is a constructor option, and there is no page to read one from
  // out here.
  const reviewer = buildFlowReviewer(options);
  const authorOptions = {
    model: new LlmFlowAuthorModel({ factory: options.factory }),
    policy: options.policy,
    probe: options.probe,
    ...(reviewer === null ? {} : { reviewer }),
    ...(tables.length > 0 ? { tables } : {}),
    ...(projectContext !== '' ? { projectContext } : {}),
    // The third grounding source for expectUrl. A route the application
    // declares is evidence as good as the tree's own url= attributes.
    declaredRoutes: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'route')
      .map((node) => node.name),
    // The same grounding, one layer down: `METHOD /path` for every endpoint
    // the repo declares, so an authored request's METHOD can be checked —
    // see `unindexedRequestMethod`.
    declaredOperations: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'operation')
      .map((node) => node.name),
    // The run's own backend toggle. Off, no HTTP or database step is written
    // and the claims are proved through the page with a note — see
    // `FlowAuthorOptions.backend`.
    backend: options.backend,
    // Supplied by the person, never guessed — see `parseCredentials`.
    ...(options.credentials ? { credentials: options.credentials } : {}),
    scope: options.scope,
    onLog: log,
  };

  let authored;
  try {
    authored = options.url
      ? await withPage(options.cdp, async (page) => {
          log?.(`opening ${options.url}…`);
          await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
          // Client-rendered pages need a beat before the AX tree is meaningful.
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
          const pilot = buildCapturePilot(options);
          if (pilot) await pilotCapture(page, pilot, log);
          // Read in a second tab, so `page` is still the start page when the
          // author captures the tree its selectors are checked against.
          const journeyTree = await captureJourneyTree(
            page,
            options,
            repoContextGraph,
            prompt,
            log ?? undefined,
          );
          const author = new FlowAuthor({
            ...authorOptions,
            ...(journeyTree ? { journeyTree } : {}),
          });
          return author.author(prompt, page);
        })
      : await new FlowAuthor(authorOptions).author(prompt);
  } catch (error) {
    if (error instanceof AuthoringError) {
      process.stderr.write(`wowlidator author: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // Group by the page it was written against, so the flow and the report it
  // produces end up in the same folder. An ungrounded flow has no page to be
  // named after, so it stays at the top level *of the report directory* — not
  // the working directory, which is wherever the caller happened to be and, via
  // the `grimval` wrapper, is the engine's own checkout.
  const group =
    authored.sourceUrl === undefined ? undefined : reportGroupForUrl(authored.sourceUrl);
  const dir = group === undefined ? resolve(options.reportDir) : pageDir(options, group);
  const flowPath =
    options.flow === undefined
      ? join(dir, flowFilename({ runId: '', name: authored.flow.name, status: 'authored', group }))
      : resolve(options.flow);

  await writeFlowFile(flowPath, authored.flow);

  const totalSteps =
    (authored.flow.setup?.length ?? 0) +
    authored.flow.steps.length +
    (authored.flow.teardown?.length ?? 0);

  process.stdout.write(
    `authored "${authored.flow.name}" — ${totalSteps} step(s)\n` +
      `  model      ${authored.model} (${authored.latencyMs}ms, ${authored.inputTokens ?? 0} in / ${authored.outputTokens ?? 0} out tokens)\n` +
      `  grounded   ${authored.grounded ? `yes — selectors checked against ${authored.sourceUrl}` : 'NO — selectors are guesses; verify every one before trusting this'}\n` +
      `  rationale  ${authored.rationale}\n` +
      (group === undefined ? '' : `  folder     ${dir}\n`) +
      `  flow       ${flowPath}\n`,
  );
  // Surfaced, not silently dropped — a rising count means the prompt is slipping.
  if (authored.droppedSteps > 0) {
    process.stdout.write(
      `  ! dropped ${authored.droppedSteps} malformed step(s) the model emitted\n`,
    );
  }
  if (authored.notes.trim() !== '') {
    process.stdout.write(`  ! notes     ${authored.notes}\n`);
  }

  if (!options.run) return 0;

  log?.(`\nrunning "${authored.flow.name}"…`);
  const bundle = await runFlow(authored.flow, {
    cdpUrl: options.cdp,
    cachePath: options.cache,
    screenshots: options.screenshots,
    video: options.video,
    agentAssist: options.agentAssist,
      backend: options.backend,
    captureDelayMs: options.captureDelayMs,
      stepDelayMs: options.stepDelayMs,
    makeHealer: buildHealer(options),
      stepRepair: buildStepRepair(options),
    healer: options.heal ? undefined : null,
    agent: buildAgent(options),
    dataModel: buildDataModel(options),
    updateBaselines: options.updateBaselines,
    network: options.network,
    // Carried for masking only: a password the person supplied must not
    // reach the proof bundle or the emailable report in cleartext.
    credentials: options.credentials,
    historyPath: options.history ? options.historyPath : null,
    onStep: stepLogger(options),
    onPlan: planLogger(options),
    generatedBy: {
      model: authored.model,
      generatedAt: authored.authoredAt,
      sourceUrl: authored.sourceUrl ?? 'authored from prompt',
      kind: 'functional',
      rationale: authored.rationale,
    },
  });

  const proofPath = await writeProofBundle(bundle, options.out);
  const target = resolveReportPath(
    { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
    { runId: bundle.runId, name: bundle.name, status: bundle.status, group },
  );
  const reportPath = target === null ? null : await writeHtmlReport(bundle, target);

  process.stdout.write(
    `\n${formatProofSummary(bundle)}\n` +
      (meaningfulCoverage(bundle) ? `  ${formatCoverage(bundle.coverage!)}\n` : '') +
      (bundle.trend ? `  ${formatTrend(bundle.trend)}\n` : '') +
      `  proof      ${proofPath}\n` +
      (reportPath === null ? '' : `  report     ${reportPath}\n`),
  );
  if (bundle.error) process.stderr.write(`\n${bundle.error}\n`);

  const quarantine = await applyQuarantine(bundle, options);
  await writeMachineReports([bundle], options);
  await openReport(reportPath, options);
  await cleanupChrome(options);
  return quarantine.quarantined ? EXIT.ok : exitCodeFor(bundle);
}
