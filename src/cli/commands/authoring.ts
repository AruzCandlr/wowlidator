/**
 * The commands that write tests: generate, author, draft, and catalog.
 * Split out of cli.ts verbatim.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  describeCase,
  parseTestCaseTable,
  renderTestCaseTable,
  tableToClaims,
  type TestCaseRow,
} from '../../catalog/test-case-table.js';
import { ContextEngine } from '../../context/context-engine.js';
import { formatCoverage, meaningfulCoverage } from '../../coverage/ax-coverage.js';
import { formatProofSummary, writeProofBundle } from '../../engine/proof-bundle.js';
import { runFlow, withPage, type Flow } from '../../engine/runner.js';
import { pilotCapture } from '../../context/capture-pilot.js';
import {
  ApiTestGenerator,
  LlmApiGeneratorModel,
  NoSpecError,
} from '../../generator/api-test-generator.js';
import {
  AuthoringError,
  DEFAULT_AUTHOR_MAX_NODES,
  FlowAuthor,
  LlmFlowAuthorModel,
  caseFlows,
  type AuthoredFlow,
} from '../../generator/flow-author.js';
import { LlmGeneratorModel, TestGenerator } from '../../generator/test-generator.js';
import type { GeneratedSuite } from '../../generator/test-generator.js';
import { captureAxTree } from '../../healer/jit-healer.js';
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
import { EXIT, exitCodeFor, suiteExit } from '../exit.js';
import type { CliOptions } from '../options.js';
import {
  assertRolesResolvable,
  buildAgent,
  buildCapturePilot,
  buildDataModel,
  buildHealer,
  buildStepRepair,
  lineLogger,
  planLogger,
  stepLogger,
} from '../runtime.js';
import { runCases } from '../run-cases.js';

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

  // Static, no model call — see cmdContext. Purely additive to the prompt.
  const projectGraph =
    options.context || options.api
      ? await new ContextEngine({
          rootDir: options.root,
          cacheFile: options.contextOut,
          openApiSpec: options.openapi,
        }).build()
      : undefined;

  const log = lineLogger(options);

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
async function authorEachRow(
  rows: readonly TestCaseRow[],
  author: FlowAuthor,
  options: CliOptions,
  context: {
    summary: string;
    context: readonly Awaited<ReturnType<typeof extractDocumentFile>>[];
    log: ((line: string) => void) | undefined;
  },
): Promise<{ first: AuthoredFlow; cases: { name: string; flow: Flow; scenarioId: string }[] }> {
  const cases: { name: string; flow: Flow; scenarioId: string }[] = [];
  let first: AuthoredFlow | undefined;
  const refused: string[] = [];

  const authorRow = async (row: TestCaseRow, page?: Page): Promise<void> => {
    const prompt = buildAuthoringPrompt(
      [
        {
          claim: row.testCase,
          priority: row.priority || 'medium',
          source: row.caseId,
          testable: true,
        },
      ],
      { summary: context.summary, context: context.context, cases: [describeCase(row)] },
    );
    context.log?.(`writing ${row.caseId}: ${row.testCase}…`);
    try {
      const one = await author.author(prompt, page);
      first ??= one;
      cases.push({
        name: `${row.caseId} ${row.testCase}`,
        flow: { ...one.flow, name: `${row.caseId} ${row.testCase}` },
        scenarioId: row.scenarioId || 'ungrouped',
      });
    } catch (error) {
      if (!(error instanceof AuthoringError)) throw error;
      refused.push(`${row.caseId}: ${error.message.split('\n')[0] ?? ''}`);
      process.stderr.write(`  ! ${row.caseId} could not be written — ${error.message.split('\n')[0]}\n`);
    }
  };

  if (options.url) {
    await withPage(options.cdp, async (page) => {
      context.log?.(`opening ${options.url}…`);
      await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      for (const row of rows) await authorRow(row, page);
    });
  } else {
    for (const row of rows) await authorRow(row);
  }

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

  const log = lineLogger(options);

  // --- the document, and its supporting cast --------------------------------
  let document;
  const contextDocs = [];
  try {
    document = await extractDocumentFile(resolve(file));
    for (const path of options.contextDocs) {
      contextDocs.push(await extractDocumentFile(resolve(path)));
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
  } else {
    log?.('asking the generator role what this document claims…');
    const model = new LlmCatalogModel({ factory: options.factory });
    let claims;
    try {
      claims = await extractClaims(model, {
        document,
        context: contextDocs,
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

  const author = new FlowAuthor({
    model: new LlmFlowAuthorModel({ factory: options.factory }),
    policy: options.policy,
    probe: options.probe,
    onLog: log,
  });

  // A table row carries the steps a tester would take and what each should
  // produce, keyed step-by-step. That is strictly more than the claim sentence
  // the general path distils it into, so when the rows are there the author gets
  // them — the difference between a model inventing a journey and being told it.
  const approvedIds = new Set(approvedClaims(claimsFile).map((claim) => claim.source));
  const rows = table === null ? [] : table.filter((row) => approvedIds.has(row.caseId));

  let authored: AuthoredFlow;
  let tableCases: { name: string; flow: Flow; scenarioId: string }[] = [];
  try {
    if (rows.length > 0) {
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
      const authoredRows = await authorEachRow(rows, author, options, {
        summary: claimsFile.summary,
        context: contextDocs,
        log,
      });
      authored = authoredRows.first;
      tableCases = authoredRows.cases;
    } else {
      const prompt = buildAuthoringPrompt(approvedClaims(claimsFile), {
        summary: claimsFile.summary,
        context: contextDocs,
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
  const cases: { name: string; flow: Flow; scenarioId?: string | undefined }[] =
    tableCases.length > 0 ? tableCases : caseFlows(authored);
  const flowPaths: string[] = [];
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

  const totalSteps =
    (authored.flow.setup?.length ?? 0) +
    authored.flow.steps.length +
    (authored.flow.teardown?.length ?? 0);

  process.stdout.write(
    `authored "${authored.flow.name}" — ${totalSteps} step(s) in ${cases.length} case(s) for ${approved.length} claim(s)\n` +
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

  if (!options.run) return 0;

  // Every case runs, even after one fails — same reasoning as `fillEach`, one
  // level up: a catalog answered halfway is far less useful than the whole
  // table, and the claims after a failure were approved by someone who is still
  // owed an answer about them. `runCases` also survives a case that *throws*,
  // which a failed case does not: see its note.
  const outcomes = await runCases(
    cases.map((testCase) => ({
      name: testCase.name,
      flow: testCase.flow,
      kind: 'catalog',
      ...(testCase.scenarioId !== undefined && group !== undefined
        ? { group: `${group}/${slugify(testCase.scenarioId)}` }
        : {}),
      generatedBy: {
        model: authored.model,
        generatedAt: authored.authoredAt,
        sourceUrl: authored.sourceUrl ?? `catalog: ${document.name}`,
        kind: 'catalog',
        rationale: claimsFile.summary || authored.rationale,
      },
    })),
    options,
    { dir, group, indexTitle: `wowlidator catalog — ${document.name}` },
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

  const author = new FlowAuthor({
    model: new LlmFlowAuthorModel({ factory: options.factory }),
    policy: options.policy,
    probe: options.probe,
    onLog: log,
  });

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
          return author.author(prompt, page);
        })
      : await author.author(prompt);
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
    captureDelayMs: options.captureDelayMs,
      stepDelayMs: options.stepDelayMs,
    makeHealer: buildHealer(options),
      stepRepair: buildStepRepair(options),
    healer: options.heal ? undefined : null,
    agent: buildAgent(options),
    dataModel: buildDataModel(options),
    updateBaselines: options.updateBaselines,
    network: options.network,
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
