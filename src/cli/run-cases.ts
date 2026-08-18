/**
 * Running a list of cases — one report per case, every case accounted for.
 * Split out of cli.ts verbatim.
 */

import { join } from 'node:path';

import { formatCoverage, meaningfulCoverage } from '../coverage/ax-coverage.js';
import {
  formatProofSummary,
  writeProofBundle,
  type Defect,
  type GenerationProvenance,
} from '../engine/proof-bundle.js';
import { runFlow, type Flow } from '../engine/runner.js';
import { formatTrend } from '../history/run-history.js';
import { resolveReportPath, writeHtmlReport } from '../reporter/html-reporter.js';
import {
  DEFAULT_INDEX_FILENAME,
  writeSuiteIndex,
  type IndexEntry,
} from '../reporter/suite-index.js';
import { failureOf, neverRan, type CaseOutcome } from './exit.js';
import type { CliOptions } from './options.js';
import {
  buildAgent,
  buildDataModel,
  buildHealer,
  buildStepRepair,
  lineLogger,
  planLogger,
  stepLogger,
} from './runtime.js';

/** One listed case, ready to run. */
export interface SuiteCase {
  /** How the case is named in the roll-up. */
  name: string;
  flow: Flow;
  /** Report `kind` — `catalog`, or the generator's own classification. */
  kind: string;
  /**
   * Sub-folder for this case's artifacts, when the list has classes of its own.
   * A catalog's Scenario ID is one: the sheet already groups its rows, and a
   * folder per scenario keeps that grouping instead of flattening twelve
   * unrelated cases into one directory.
   */
  group?: string | undefined;
  generatedBy: GenerationProvenance;
  /** Static findings, ridden along with one case so they are not lost. */
  defects?: readonly Defect[] | undefined;
}

/**
 * Run every listed case, and report on every one of them.
 *
 * **A case that throws is logged and the list continues.** `runFlow` returning a
 * failed bundle was always survivable — that is an answer. An *exception* is
 * not: a dropped CDP connection, a browser killed mid-run, a report that could
 * not be written. Those used to escape the loop, so cases after the first
 * infrastructure hiccup were never run, never listed, and the roll-up that would
 * have said so never printed either. Ten cases went in, six lines came out, and
 * nothing in the output was false — it was just missing, which is worse, because
 * the four that vanished look exactly like cases nobody wrote.
 *
 * **Blocked is not failed.** A case that never produced a verdict proved nothing
 * about the application, in either direction. Calling it a failure would file
 * the harness's own gap as a defect in the product — the same distinction
 * `proofs-to-artifacts.py` already makes for a step that never ran.
 */
export async function runCases(
  cases: readonly SuiteCase[],
  options: CliOptions,
  where: { dir: string; group: string | undefined; indexTitle: string },
): Promise<CaseOutcome[]> {
  const log = lineLogger(options);
  const entries: IndexEntry[] = [];
  const outcomes: CaseOutcome[] = [];

  for (const [index, testCase] of cases.entries()) {
    log?.(`\nrunning "${testCase.name}"…`);
    try {
      const bundle = await runFlow(testCase.flow, {
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
        // Carried for masking only: a password the person supplied must not
        // reach the proof bundle or the emailable report in cleartext.
        credentials: options.credentials,
        historyPath: options.history ? options.historyPath : null,
        onStep: stepLogger(options),
        onPlan: planLogger(options),
        defects: testCase.defects,
        generatedBy: testCase.generatedBy,
      });

      const proofPath = await writeProofBundle(bundle, options.out);
      const target = resolveReportPath(
        { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
        {
          runId: bundle.runId,
          name: bundle.name,
          status: bundle.status,
          // index/kind are what stop one case's report overwriting the next.
          ...(cases.length === 1 ? {} : { index: index + 1 }),
          group: testCase.group ?? where.group,
          kind: testCase.kind,
        },
      );
      const reportPath = target === null ? null : await writeHtmlReport(bundle, target);

      process.stdout.write(
        `\n${formatProofSummary(bundle)}\n` +
          (meaningfulCoverage(bundle) ? `  ${formatCoverage(bundle.coverage!)}\n` : '') +
          (bundle.trend ? `  ${formatTrend(bundle.trend)}\n` : '') +
          `  proof      ${proofPath}\n` +
          (reportPath === null ? '' : `  report     ${reportPath}\n`),
      );
      const blocked = neverRan(bundle);
      if (blocked !== null) {
        // Said out loud, at the moment it happens, and on stderr: this is not a
        // verdict, and a reader scanning stdout for verdicts must not take it
        // for one. It keeps its report — the evidence of what went wrong is
        // still worth having — but it is not filed among the results.
        process.stderr.write(`  ! never ran: ${blocked}\n`);
      }
      if (reportPath !== null && blocked === null) entries.push({ bundle, reportPath });
      outcomes.push({
        name: testCase.name,
        verdict: blocked !== null ? 'blocked' : bundle.status === 'passed' ? 'passed' : 'failed',
        bundle,
        reportPath: reportPath ?? undefined,
        reason: blocked ?? failureOf(bundle),
      });
    } catch (error) {
      // The narrower case: something threw before there was a bundle at all —
      // a report that could not be written, an unexpected engine error.
      const reason = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
      process.stderr.write(`\nBLOCKED ${testCase.name} — ${reason}\n`);
      outcomes.push({ name: testCase.name, verdict: 'blocked', bundle: null, reason });
    }
  }

  if (outcomes.length > 1) {
    const blocked = outcomes.filter((o) => o.verdict === 'blocked');
    const failed = outcomes.filter((o) => o.verdict === 'failed');
    const passed = outcomes.length - blocked.length - failed.length;

    // One line per listed case, always all of them. The roll-up is the only
    // place the reader can see that the count adds up.
    process.stdout.write(
      `\n${outcomes.length} case(s) — ${passed} passed, ${failed.length} failed` +
        (blocked.length > 0 ? `, ${blocked.length} never ran` : '') +
        '\n',
    );
    // Every listed case gets a line, and every line that is not a pass says why.
    // A bare ✗ with nothing after it was the worst of both: it read as a defect
    // and gave nobody anything to act on.
    const MARK = { passed: '✓', failed: '✗', blocked: '⃠' } as const;
    for (const outcome of outcomes) {
      process.stdout.write(
        `  ${MARK[outcome.verdict]} ${outcome.name}` +
          (outcome.verdict === 'blocked' ? ' — never ran' : '') +
          (outcome.reason === undefined ? '' : `: ${outcome.reason}`) +
          '\n',
      );
    }

    // One front door for the folder: several reports with no index is several
    // files nobody opens, and the red one is as hidden as the green ones. The
    // blocked cases are listed there too, with no link, because there is
    // nothing to link to and an index of 7 rows for 10 cases reads as 7 cases.
    if (entries.length > 1 || blocked.length > 0) {
      const indexPath = await writeSuiteIndex(entries, join(where.dir, DEFAULT_INDEX_FILENAME), {
        title: where.indexTitle,
        blocked: blocked.map((o) => ({
          name: o.name,
          reason: o.reason ?? 'unknown',
          ...(o.reportPath === undefined ? {} : { reportPath: o.reportPath }),
        })),
      });
      process.stdout.write(`\n  index      ${indexPath}\n`);
    }
  }

  return outcomes;
}
