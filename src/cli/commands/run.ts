/**
 * The commands that execute flows: run (with --repair), crawl, and watch.
 * Split out of cli.ts verbatim.
 */

import { readFile } from 'node:fs/promises';
import { isPassing, type AgentRecord } from '../../engine/proof-bundle.js';
import { basename, dirname, resolve } from 'node:path';

import { CacheManager } from '../../cache/cache-manager.js';
import { formatCoverage, meaningfulCoverage } from '../../coverage/ax-coverage.js';
import { crawlFrom, formatCrawlReport, type CrawlReport } from '../../crawl/crawler.js';
import { hasIncludes } from '../../engine/compose.js';
import { captureEvidence } from '../../engine/evidence.js';
import {
  ProofBundleBuilder,
  formatProofSummary,
  writeProofBundle,
} from '../../engine/proof-bundle.js';
import { isBrowserFree, runFlow, withPage, type Flow } from '../../engine/runner.js';
import { formatTrend } from '../../history/run-history.js';
import { FlowRepairLoop } from '../../repair/flow-repair-loop.js';
import { LlmFlowRepairModel } from '../../repair/flow-repair-model.js';
import {
  reportGroupForUrl,
  resolveReportPath,
  writeHtmlReport,
} from '../../reporter/html-reporter.js';
import {
  classifyChange,
  formatWatchLine,
  notifyPayload,
  parseInterval,
  runNotify,
  type WatchState,
} from '../../watch.js';
import {
  applyQuarantine,
  cleanupChrome,
  groupForFlow,
  isFlow,
  openReport,
  prepare,
  writeFlowFile,
  writeMachineReports,
} from '../artifacts.js';
import { withWorkflowScripts } from '../case-plan.js';
import { EXIT, exitCodeFor, suiteExit } from '../exit.js';
import type { CliOptions } from '../options.js';
import { runCases, type SuiteCase } from '../run-cases.js';
import {
  assertRolesResolvable,
  buildAgent,
  buildDataModel,
  buildHealer,
  buildStepRepair,
  buildReviewJudge,
  buildInvestigationAgent,
  lineLogger,
  planLogger,
  runPersonas,
  stepLogger,
} from '../runtime.js';

export async function cmdRun(flowPaths: readonly string[], options: CliOptions): Promise<number> {
  if (flowPaths.length === 0) {
    process.stderr.write('wowlidator run: missing <flow.json>\n');
    return 2;
  }
  // Several files run as one suite through `runCases` — the same loop behind
  // `catalog --run` — so the roll-up, the suite index, `--repair` autoheal and
  // the per-case `[cN]` output all come along. One file is byte-for-byte the
  // run it always was.
  if (flowPaths.length > 1) return cmdRunMany(flowPaths, options);
  const flowPath = flowPaths[0]!;

  const loaded = await loadFlow(flowPath);
  if (typeof loaded === 'number') return loaded;
  const parsed = loaded;

  // A flow of pure HTTP steps never opens a page, so it must not open a
  // browser either — `runFlow` already dispatches it to the browser-free path.
  // Conservative when fragments are involved: `use` can splice UI steps in, and
  // that is only knowable after expansion, so those still get a browser.
  const needsBrowser = hasIncludes(parsed) || !isBrowserFree(parsed);
  if (needsBrowser) {
    const blocked = await prepare(options, typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined);
    if (blocked !== null) return blocked;
  }

  if (options.repair) {
    return cmdRunWithRepair(flowPath, parsed, options);
  }

  const bundle = await runFlow(parsed, {
    // `use` paths are relative to the flow that used them, not to wherever
    // the command was typed.
    flowDir: dirname(resolve(flowPath)),
    // A re-run of an authored case belongs to the pass that authored it, not
    // to a pile of hand-written flows. See `Flow.authoredBy`.
    ...(parsed.authoredBy === undefined ? {} : { generatedBy: parsed.authoredBy }),
    cdpUrl: options.cdp,
    cachePath: options.cache,
    screenshots: options.screenshots,
    highlightTarget: options.highlightTarget,
    video: options.video,
    agentAssist: options.agentAssist,
    backend: options.backend,
    captureDelayMs: options.captureDelayMs,
      stepDelayMs: options.stepDelayMs,
    makeHealer: buildHealer(options),
      stepRepair: buildStepRepair(options),
      reviewJudge: buildReviewJudge(options),
    healer: options.heal ? undefined : null,
    agent: buildAgent(options),
    dataModel: buildDataModel(options),
    updateBaselines: options.updateBaselines,
    network: options.network,
    // Carried for masking only: a password the person supplied must not
    // reach the proof bundle or the emailable report in cleartext.
    credentials: options.credentials,
    personas: runPersonas(options),
    historyPath: options.history ? options.historyPath : null,
    onStep: stepLogger(options),
    onPlan: planLogger(options),
  });

  // Fold successful agent journeys back into the flow file as deterministic
  // scripts — the same move `runCases` makes for suites (see run-cases.ts),
  // so a single-flow run also leaves a $0 replay behind: the next run of
  // this exact file replays the recorded steps with no model turn, and the
  // proof written below keeps the full agent action log as the evidence.
  // Best-effort on purpose: a script that could not be written costs a few
  // model turns next run, never a verdict.
  {
    const journeys = bundle.steps
      .map((step) => step.agent)
      .filter((record): record is AgentRecord => record !== undefined && record.success);
    const scripted = withWorkflowScripts(parsed, journeys);
    if (scripted !== null) {
      await writeFlowFile(resolve(flowPath), scripted)
        .then(() =>
          // stderr: `--json` owns stdout, and this is narration, not the result.
          process.stderr.write('  scripted   agent journey recorded in the flow for $0 replay\n'),
        )
        .catch(() => undefined);
    }
  }

  const proofPath = await writeProofBundle(bundle, options.out);
  const target = resolveReportPath(
    { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
    {
      runId: bundle.runId,
      name: bundle.name,
      status: bundle.status,
      // Land beside anything else already recorded for this page.
      group: groupForFlow(parsed),
    },
  );
  const reportPath = target === null ? null : await writeHtmlReport(bundle, target);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...bundle, proofPath, reportPath }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${formatProofSummary(bundle)}\n` +
        (meaningfulCoverage(bundle) ? `  ${formatCoverage(bundle.coverage!)}\n` : '') +
        (bundle.trend ? `  ${formatTrend(bundle.trend)}\n` : '') +
        `  proof      ${proofPath}\n` +
        (reportPath === null ? '' : `  report     ${reportPath}\n`),
    );
    if (bundle.error) process.stderr.write(`\n${bundle.error}\n`);
  }

  const quarantine = await applyQuarantine(bundle, options);
  await writeMachineReports([bundle], options);
  await openReport(reportPath, options);
  await cleanupChrome(options);
  return quarantine.quarantined ? EXIT.ok : exitCodeFor(bundle);
}

/** Read and validate one flow file, or the exit code its failure earns. */
async function loadFlow(flowPath: string): Promise<Flow | number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(flowPath, 'utf8'));
  } catch (error) {
    // A missing or malformed file is the caller's mistake, not a failed test —
    // exit 2, and say which of the two it was rather than leaking an ENOENT.
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      /ENOENT/.test(detail)
        ? `wowlidator run: no such flow file: ${flowPath}\n`
        : `wowlidator run: ${flowPath} is not valid JSON — ${detail}\n`,
    );
    return EXIT.usage;
  }
  if (!isFlow(parsed)) {
    process.stderr.write(`wowlidator run: ${flowPath} is not a valid flow (needs "name" and "steps")\n`);
    return EXIT.usage;
  }
  return parsed;
}

/**
 * `wowlidator run a.flow.json b.flow.json …` — the listed flows as one suite.
 *
 * Exists for wowUI's group-level "Rerun all" / "Heal all" buttons: re-running a
 * catalog's cases used to mean one job per case, clicked one at a time, against
 * a server that refuses a second browser command while one runs. A list is one
 * job holding the browser once. Every file is read up front — a typo in the
 * fifth path fails the command before any browser time is spent, the same
 * "fail at the boundary" rule `parseArgs` follows.
 *
 * Each flow keeps its own provenance (`authoredBy`), so a re-run of an authored
 * case still lands in the pass's group in wowUI rather than reading as a
 * hand-written flow. With `--repair`, `runCases`' ordinary autoheal applies.
 */
async function cmdRunMany(flowPaths: readonly string[], options: CliOptions): Promise<number> {
  const cases: SuiteCase[] = [];
  for (const flowPath of flowPaths) {
    const loaded = await loadFlow(flowPath);
    if (typeof loaded === 'number') return loaded;
    cases.push({
      name: loaded.name,
      flow: loaded,
      flowPath,
      kind: 'run',
      generatedBy: loaded.authoredBy,
    });
  }

  // One `prepare` for the lot — the same browser serves every case. A list of
  // pure API flows never opens one, exactly as a single API flow does not.
  const browserFlow = cases.find((c) => hasIncludes(c.flow) || !isBrowserFree(c.flow));
  if (browserFlow !== undefined) {
    const blocked = await prepare(
      options,
      typeof browserFlow.flow.baseUrl === 'string' ? browserFlow.flow.baseUrl : undefined,
    );
    if (blocked !== null) return blocked;
  }

  const outcomes = await runCases(cases, options, {
    dir: resolve(options.reportDir),
    group: undefined,
    indexTitle: `wowlidator run — ${cases.length} flow(s)`,
  });

  const ran = outcomes.flatMap((o) => (o.bundle === null ? [] : [o.bundle]));
  await writeMachineReports(ran, options);
  await openReport(outcomes.find((o) => o.reportPath !== undefined)?.reportPath ?? null, options);
  await cleanupChrome(options);
  return suiteExit(outcomes);
}

/**
 * `wowlidator run --repair`: on failure, ask the generator role to rewrite the
 * flow around it and retry, up to `options.repairAttempts` total runs.
 * Never touches `flowPath` itself — see `FlowRepairLoop`'s module comment
 * for why each attempt lands as its own reviewable file instead.
 */
async function cmdRunWithRepair(flowPath: string, flow: Flow, options: CliOptions): Promise<number> {
  // Reinvestigation drives a browser through the agent role, so its key is
  // checked up front for the same reason the generator's is.
  const roles: ('healer' | 'generator' | 'agent')[] = options.repairInvestigate
    ? ['generator', 'agent']
    : ['generator'];
  const gate = assertRolesResolvable(options, roles);
  if (gate) {
    process.stderr.write(`wowlidator run --repair: ${gate}\n`);
    return EXIT.environment;
  }

  const baseName = basename(flowPath).replace(/\.flow\.json$/i, '').replace(/\.json$/i, '');
  const outDir = dirname(resolve(flowPath));

  const loop = new FlowRepairLoop({
    model: new LlmFlowRepairModel({ factory: options.factory }),
    maxAttempts: options.repairAttempts,
    outDir,
    onLog: lineLogger(options),
    // A dedicated agent instance, not `buildAgent(options)`: that one is
    // gated on `--no-agent` (workflow steps inside the run), while this one
    // is gated on `--repair-investigate` — different opt-ins for different
    // acts on the application.
    agent: options.repairInvestigate ? buildInvestigationAgent(options) : null,
    regenerateFrom: options.repairRegenerate,
    runOptions: {
      cdpUrl: options.cdp,
      cachePath: options.cache,
      screenshots: options.screenshots,
      highlightTarget: options.highlightTarget,
      video: options.video,
      agentAssist: options.agentAssist,
      backend: options.backend,
      captureDelayMs: options.captureDelayMs,
      stepDelayMs: options.stepDelayMs,
      makeHealer: buildHealer(options),
      stepRepair: buildStepRepair(options),
      reviewJudge: buildReviewJudge(options),
      healer: options.heal ? undefined : null,
      agent: buildAgent(options),
      dataModel: buildDataModel(options),
      updateBaselines: options.updateBaselines,
      network: options.network,
      // Carried for masking only: a password the person supplied must not
      // reach the proof bundle or the emailable report in cleartext.
      credentials: options.credentials,
      personas: runPersonas(options),
      historyPath: options.history ? options.historyPath : null,
      onStep: stepLogger(options),
      onPlan: planLogger(options),
    },
  });

  const outcome = await loop.run(flow, baseName);
  const lastAttempt = outcome.attempts[outcome.attempts.length - 1];
  if (!lastAttempt) {
    process.stderr.write('wowlidator run --repair: no attempts were recorded\n');
    return 1;
  }
  const bundle = lastAttempt.bundle;

  const proofPath = await writeProofBundle(bundle, options.out);
  const target = resolveReportPath(
    { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
    { runId: bundle.runId, name: bundle.name, status: bundle.status, group: groupForFlow(flow) },
  );
  const reportPath = target === null ? null : await writeHtmlReport(bundle, target);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: outcome.status,
          attempts: outcome.attempts.map((a) => ({
            attempt: a.attempt,
            status: a.bundle.status,
            runId: a.bundle.runId,
            repair: a.repair,
            investigation: a.investigation,
          })),
          proofPath,
          reportPath,
          bundle,
        },
        null,
        2,
      )}\n`,
    );
    return outcome.status === 'passed' ? 0 : 1;
  }

  // The attempt-by-attempt narration already streamed live via onLog above —
  // this is just the reviewable-file paths, collected in one place.
  const repaired = outcome.attempts.filter((a) => a.repair);
  if (repaired.length > 0) {
    process.stdout.write('\n');
    for (const a of repaired) {
      process.stdout.write(`  flow   ${a.repair!.flowPath}\n`);
      process.stdout.write(`  patch  ${a.repair!.patchPath}\n`);
    }
  }

  process.stdout.write(
    `\n${formatProofSummary(bundle)}\n` +
      (meaningfulCoverage(bundle) ? `  ${formatCoverage(bundle.coverage!)}\n` : '') +
      `  proof      ${proofPath}\n` +
      (reportPath === null ? '' : `  report     ${reportPath}\n`),
  );

  if (outcome.status === 'dead-end') {
    process.stderr.write(
      `\n✗ DEAD END — still failing after ${outcome.attempts.length} attempt(s). ` +
        `See the .patch file(s) above for what was tried.\n`,
    );
  }

  return outcome.status === 'passed' ? 0 : 1;
}

/**
 * Follow every link on a page, check the destination, and come back.
 *
 * A cheap sweep for the pages a flow-per-journey would never cover — see
 * `src/crawl/crawler.ts` for why it follows links only.
 */
export async function cmdCrawl(url: string | undefined, options: CliOptions): Promise<number> {
  if (!url) {
    process.stderr.write('wowlidator crawl: missing <url>\n');
    return EXIT.usage;
  }

  const blocked = await prepare(options, url);
  if (blocked !== null) return blocked;

  const log = lineLogger(options);
  const cache = new CacheManager(
    options.cache === undefined ? {} : { filePath: options.cache },
  );
  await cache.load();
  const crawlHealer = options.heal ? (buildHealer(options)?.(cache) ?? null) : null;

  const bundle = new ProofBundleBuilder({
    name: `crawl ${url}`,
    cdpUrl: options.cdp,
    cachePath: cache.filePath,
    healerModel: crawlHealer?.model.id ?? null,
    onStep: stepLogger(options),
  });

  let report: CrawlReport | undefined;
  const started = Date.now();
  try {
    await withPage(options.cdp, async (page) => {
      const startedAt = new Date().toISOString();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      bundle.addStep({
        action: 'goto',
        intent: 'Open the page the crawl starts from.',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: page.url(),
        // The page every destination is measured against, and the one every
        // "could not return" finding is about.
        screenshot: await captureEvidence(
          page,
          options.screenshots ?? 'all',
          'routine',
          options.captureDelayMs,
        ),
      });
      report = await crawlFrom(
        page,
        {
          maxPages: options.maxPages,
          maxHealAttempts: options.maxHeal,
          followButtons: options.followButtons,
          timeoutMs: options.timeoutMs,
          // A crawl is never filmed — it drives a borrowed page rather than a
          // recording context — so stills stay its only evidence.
          screenshots: options.screenshots ?? 'all',
          captureDelayMs: options.captureDelayMs,
          // A crawl writes its own selectors from accessible names, so when one
          // fails the author has nothing to fix — healing is the difference
          // between covering a page and giving up on it.
          healer: options.heal ? crawlHealer : null,
          onLog: log,
        },
        bundle,
      );
    });
  } catch (error) {
    bundle.recordRunError(error);
  }

  const finished = bundle.finish();
  const target = resolveReportPath(
    { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
    { runId: finished.runId, name: finished.name, status: finished.status, group: reportGroupForUrl(url) },
  );
  const reportPath = target === null ? null : await writeHtmlReport(finished, target);
  await writeProofBundle(finished, options.out);

  process.stdout.write(
    `\n${formatProofSummary(finished)}\n` +
      (report ? `${formatCrawlReport(report)}\n` : '') +
      (reportPath === null ? '' : `  report     ${reportPath}\n`),
  );
  await writeMachineReports([finished], options);
  await openReport(reportPath, options);
  await cleanupChrome(options);
  return exitCodeFor(finished);
}

/**
 * Re-run a flow on an interval, speaking up only when the result changes.
 *
 * Foreground and interruptible on purpose — see `src/watch.ts` for why this is
 * not a daemon and why the notify seam is a command rather than an integration.
 */
export async function cmdWatch(flowPath: string | undefined, options: CliOptions): Promise<number> {
  if (!flowPath) {
    process.stderr.write('wowlidator watch: missing <flow.json>\n');
    return EXIT.usage;
  }

  let intervalMs: number;
  try {
    intervalMs = parseInterval(options.every);
  } catch (error) {
    process.stderr.write(`wowlidator watch: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.usage;
  }

  let flow: unknown;
  try {
    flow = JSON.parse(await readFile(flowPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      /ENOENT/.test(detail)
        ? `wowlidator watch: no such flow file: ${flowPath}\n`
        : `wowlidator watch: ${flowPath} is not valid JSON — ${detail}\n`,
    );
    return EXIT.usage;
  }
  if (!isFlow(flow)) {
    process.stderr.write(`wowlidator watch: ${flowPath} is not a valid flow\n`);
    return EXIT.usage;
  }

  const blocked = await prepare(options);
  if (blocked !== null) return blocked;

  process.stdout.write(
    `watching ${flowPath} every ${Math.round(intervalMs / 1000)}s — Ctrl-C to stop` +
      `${options.notify ? `, notifying on change via: ${options.notify}` : ''}\n`,
  );

  const state: WatchState = {};
  let iteration = 0;
  let lastCode: number = EXIT.ok;

  for (;;) {
    iteration += 1;
    const bundle = await runFlow(flow, {
      flowDir: dirname(resolve(flowPath)),
      ...(flow.authoredBy === undefined ? {} : { generatedBy: flow.authoredBy }),
      cdpUrl: options.cdp,
      cachePath: options.cache,
      screenshots: options.screenshots,
      highlightTarget: options.highlightTarget,
      video: options.video,
      agentAssist: options.agentAssist,
      backend: options.backend,
      captureDelayMs: options.captureDelayMs,
      stepDelayMs: options.stepDelayMs,
      makeHealer: buildHealer(options),
      stepRepair: buildStepRepair(options),
      reviewJudge: buildReviewJudge(options),
      healer: options.heal ? undefined : null,
      agent: buildAgent(options),
      dataModel: buildDataModel(options),
      network: options.network,
      // Carried for masking only: a password the person supplied must not
      // reach the proof bundle or the emailable report in cleartext.
      credentials: options.credentials,
      personas: runPersonas(options),
      historyPath: options.history ? options.historyPath : null,
    });

    const target = resolveReportPath(
      { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
      { runId: bundle.runId, name: bundle.name, status: bundle.status },
    );
    const reportPath = target === null ? null : await writeHtmlReport(bundle, target);
    await writeProofBundle(bundle, options.out);

    const change = classifyChange(bundle, state);
    const payload = notifyPayload(bundle, change, reportPath);
    process.stdout.write(`${formatWatchLine(payload, iteration)}\n`);

    // Only on a transition: a notification that fires every run is one people
    // mute, and a muted notifier is worse than none.
    if (options.notify && change !== 'unchanged') await runNotify(options.notify, payload);

    state.previousStatus = bundle.status;
    state.previousTrend = bundle.trend?.verdict;
    lastCode = exitCodeFor(bundle);

    if (options.untilFail && !isPassing(bundle.status)) {
      process.stdout.write('stopping: --until-fail and the run failed\n');
      return lastCode;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
