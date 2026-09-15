/**
 * The catalog report as a LIVE document (asked for 2026-09-02).
 *
 * The report used to be written once, at the suite roll-up. Now it exists
 * from the moment the run starts — every planned case a `never ran` row — and
 * is rewritten after each case finishes, so the panel's Report button opens
 * the current state of the catalog at any point of the run, not a file that
 * appears an hour later. Alongside it, `excel-export.ts` writes the per-case
 * workbook of every case that passed and removes the workbook of any case
 * that no longer does.
 *
 * Everything is derived from the LEDGER (`suite-progress.ts`): the plan, each
 * verdict, where each proof bundle landed. A bundle is read from memory when
 * this process produced it and from its `proofPath` when an earlier pass did,
 * which is what makes a resume's report answer for the whole catalog under
 * one run key rather than for the subset this process ran — and what lets
 * `wowlidator report` rebuild the same file from disk with no run at all.
 *
 * Writes are serialised and coalesced: cases finish concurrently, the file
 * carries every screenshot inline or beside the HTML, and two writers racing
 * on one path would leave a torn report. A refresh requested in flight runs
 * once more after it, never in parallel. Never fatal: a report that cannot be
 * written must not fail the suite that earned the verdicts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import type { ProofBundle, ReportLang } from '../engine/proof-bundle.js';
import { RunHistory, analyseTrend, formatTrend } from '../history/run-history.js';
import {
  casePageName,
  catalogReportPath,
  catalogCaseExportName,
  catalogMediaDirName,
  renderCatalogReport,
  writeCatalogReport,
  type CatalogReportCase,
  type CatalogReportInput,
} from '../reporter/catalog-report.js';
import { caseSidecarName, caseSidecars, renderBlockedCasePage, renderCasePage } from '../reporter/case-page.js';
import { caseVideoFile, writePassedCasesExcel, type ExcelExportResult } from '../reporter/excel-export.js';
import { writeFindingsExports, type FindingsExportResult } from '../reporter/findings-export.js';
import { caseIdOf, type SuiteLedger } from './suite-progress.js';

/**
 * The `PL_06` a planned id `PL_06_05` belongs to, when nothing better is
 * known — or the `HIR-EC` family of a dashed id `HIR-EC-006`. Only a
 * fallback: a case that ran carries the sheet's own scenario in its bundle
 * (`generatedBy.scenario`), and `buildCatalogReportCases` prefers that.
 * Before the dashed form was read (2026-09-05), a 269-scenario catalog
 * rebuilt with `wowlidator report` showed every case under "ungrouped".
 */
export function scenarioFromId(id: string): string {
  return id.match(/^([A-Za-z]+_\d+)/)?.[1] ?? id.match(/^([A-Za-z]+(?:-[A-Za-z]+)+)-\d+/)?.[1] ?? 'ungrouped';
}

/**
 * One case row per planned id, in plan order. `bundleOf` answers from memory
 * or disk; `historyOf` supplies the explanation lines (trend, heal pressure)
 * for a case that has a bundle.
 */
export async function buildCatalogReportCases(
  ledger: SuiteLedger,
  bundleOf: (id: string) => Promise<ProofBundle | null>,
  scenarioOf: (id: string) => string = scenarioFromId,
  historyOf: (bundle: ProofBundle) => Promise<readonly string[]> = async () => [],
): Promise<CatalogReportCase[]> {
  const cases: CatalogReportCase[] = [];
  for (const id of ledger.planned) {
    const outcome = ledger.outcomes[id];
    const bundle = outcome === undefined ? null : await bundleOf(id);
    // The sheet's scenario travels in the bundle; the id-shape guess is for a
    // case that never ran (no bundle) and for a caller with no plan in hand.
    const named = scenarioOf(id);
    const fromBundle = bundle?.generatedBy?.scenario;
    cases.push({
      id,
      name: outcome?.name ?? id,
      scenario: named !== 'ungrouped' ? named : (fromBundle ?? named),
      verdict: outcome === undefined ? 'never-ran' : outcome.verdict,
      status: outcome?.status ?? null,
      reason: outcome?.reason ?? null,
      bundle,
      history: bundle === null ? [] : await historyOf(bundle),
      reportPath: outcome?.reportPath ?? null,
    });
  }
  return cases;
}

export interface CatalogArtifacts {
  htmlPath: string;
  excel: ExcelExportResult;
  /** The per-case pages written this pass (`case-page.ts`), absolute. */
  casePages: string[];
  /** `<base>-findings.md` and `<base>-findings.xlsx` — the root causes, model-free (`reporter/findings-export.ts`). */
  findings: FindingsExportResult;
}

/**
 * Render and write the report, its workbooks and the findings export — the
 * one place all of them happen, so `wowlidator report` rebuilds every file
 * from the ledgers on disk without a re-run.
 */
export async function writeCatalogArtifacts(input: CatalogReportInput, cwd?: string): Promise<CatalogArtifacts> {
  const htmlPath = catalogReportPath(input.runKey, input.title, cwd);
  const mediaDirName = catalogMediaDirName(input.runKey, input.title);
  const mediaDir = join(dirname(htmlPath), mediaDirName);
  const shotsDir = join(dirname(htmlPath), mediaDirName, 'shots');
  const excelVideoCases = new Set(
    input.cases
      .filter((c) => c.verdict === 'passed' && typeof c.bundle?.video?.data === 'string' && c.bundle.video.data !== '')
      .map((c) => c.id),
  );
  const spilledRecordingCases = new Set<string>();
  let shotsDirReady = false;
  const spillScreenshot = (caseId: string, stepIndex: number, base64: string): string | null => {
    try {
      if (!shotsDirReady) {
        mkdirSync(shotsDir, { recursive: true });
        shotsDirReady = true;
      }
      const fileName = `${catalogCaseExportName(caseId)}-${stepIndex}.jpg`;
      writeFileSync(join(shotsDir, fileName), Buffer.from(base64, 'base64'));
      return `${mediaDirName}/shots/${fileName}`;
    } catch {
      return null;
    }
  };
  const spillRecording = (caseId: string, base64: string): string | null => {
    try {
      const fileName = caseVideoFile(caseId);
      const path = join(mediaDir, fileName);
      if (!excelVideoCases.has(caseId)) {
        mkdirSync(mediaDir, { recursive: true });
        writeFileSync(path, Buffer.from(base64, 'base64'));
      }
      if (!excelVideoCases.has(caseId)) spilledRecordingCases.add(caseId);
      return `${mediaDirName}/${fileName}`;
    } catch {
      return null;
    }
  };
  // **Every case is routed to a page of its own** (2026-09-11). A case with no
  // bundle used to get no page and no link, so the only trace of a blocked row
  // was one truncated line in this index — and a reader who clicked its name
  // got nowhere. A bundle-less case now links to a page that states why it did
  // not run; see `renderBlockedCasePage`.
  const casePageHref = (c: CatalogReportCase): string | null =>
    relative(dirname(htmlPath), casePageTarget(htmlPath, input, c));
  await writeCatalogReport(htmlPath, renderCatalogReport({ ...input, spillScreenshot, spillRecording, casePageHref }));
  const excel = await writePassedCasesExcel(htmlPath, input, spilledRecordingCases);
  const findings = await writeFindingsExports(htmlPath, input);
  const casePages = await writeCasePages(htmlPath, input, (id) => excelVideoCases.has(id) || spilledRecordingCases.has(id));
  return { htmlPath, excel, findings, casePages };
}

/** Where a case's page goes: the ledger's own `reportPath` when it has one, else the media folder beside its workbook. */
function casePageTarget(htmlPath: string, input: CatalogReportInput, c: CatalogReportCase): string {
  if (typeof c.reportPath === 'string' && c.reportPath !== '') return c.reportPath;
  return join(dirname(htmlPath), catalogMediaDirName(input.runKey, input.title), casePageName(c.id));
}

export interface CasePageContext {
  title: string;
  runKey: string | null;
  lang: ReportLang;
  /** The catalog report's absolute path — the page links back to it relatively. */
  indexPath: string;
  /** A recording file beside the page, when one exists there; the bundle's own data otherwise. */
  videoHref?: string | null | undefined;
}

/**
 * One case's page and its DB sidecars, at `target`. The one writer both the
 * run loop (right after the case seals, so the file the ledger names exists
 * the moment it is named) and the catalog roll-up (every live rewrite and
 * every `wowlidator report` rebuild) go through, so the two cannot differ.
 * An older file at `target` is removed first: absent is honest, stale is
 * wrong.
 */
export async function writeCasePageAt(target: string, c: CatalogReportCase, ctx: CasePageContext): Promise<string> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  await rm(target, { force: true }).catch(() => undefined);
  const sidecars = caseSidecars(c, ctx.lang);
  for (const kind of ['query', 'before', 'after', 'evidence'] as const) {
    const path = join(dir, caseSidecarName(c.id, kind));
    const content = sidecars[kind];
    if (content === null) await rm(path, { force: true }).catch(() => undefined);
    else await writeFile(path, content, 'utf8');
  }
  const html = renderCasePage({
    case: c,
    title: ctx.title,
    runKey: ctx.runKey,
    lang: ctx.lang,
    indexHref: relative(dir, ctx.indexPath),
    sidecars,
    videoHref: ctx.videoHref ?? null,
  });
  await writeFile(target, html, 'utf8');
  return target;
}

/**
 * One page per case that has a bundle, beside its workbook in the media
 * folder, with its four DB sidecars — and no page for a case that has none
 * (a never-ran row, a blocked one without a bundle): a stale page from an
 * earlier pass is removed so the folder never holds a report the index does
 * not link. Never fatal: a page that cannot be written is reported by its
 * absence from the returned list, and the catalog report already stands.
 */
export async function writeCasePages(
  htmlPath: string,
  input: CatalogReportInput,
  hasVideoFile: (caseId: string) => boolean,
): Promise<string[]> {
  const mediaDir = join(dirname(htmlPath), catalogMediaDirName(input.runKey, input.title));
  const lang = input.lang ?? 'en';
  const written: string[] = [];
  for (const c of input.cases) {
    const mediaPage = join(mediaDir, casePageName(c.id));
    const mediaSidecars = (['query', 'before', 'after', 'evidence'] as const).map((kind) => join(mediaDir, caseSidecarName(c.id, kind)));
    if (c.bundle === null) {
      // No bundle means no run: the DB sidecars belong to a run and would be
      // stale here, so they are still removed. The PAGE is not — a blocked
      // case says why on its own page, which is the whole point of routing
      // every case to one.
      for (const stale of mediaSidecars) await rm(stale, { force: true }).catch(() => undefined);
      const target = casePageTarget(htmlPath, input, c);
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          renderBlockedCasePage({
            case: c,
            title: input.title,
            runKey: input.runKey,
            lang,
            indexHref: relative(dirname(target), htmlPath),
            sidecars: { query: null, before: null, after: null, evidence: null },
            videoHref: null,
          }),
          'utf8',
        );
        written.push(target);
      } catch {
        // Never fatal, the rule this whole function already follows: a page
        // that cannot be written is reported by its absence from the list.
      }
      continue;
    }
    const target = casePageTarget(htmlPath, input, c);
    try {
      written.push(
        await writeCasePageAt(target, c, {
          title: input.title,
          runKey: input.runKey,
          lang,
          indexPath: htmlPath,
          // The recording is a file only in the media folder; a page elsewhere embeds its own.
          videoHref: target === mediaPage && hasVideoFile(c.id) ? caseVideoFile(c.id) : null,
        }),
      );
    } catch {
      // The index stands without this page; the row's link 404s rather than the run failing.
    }
  }
  return written;
}

/** The history lines the report explains a case with, from the run log. */
export async function historyLinesFor(history: RunHistory, bundle: ProofBundle): Promise<string[]> {
  try {
    const prior = await history.forFlow(bundle.name);
    const trend = analyseTrend(bundle, prior.slice(0, -1));
    const lines = [formatTrend(trend)];
    const heals = prior.reduce((sum, e) => sum + e.jitHeals, 0);
    if (heals > 0) lines.push(`${heals} heal(s) paid across the recorded runs — the selectors are drifting`);
    return lines;
  } catch {
    return [];
  }
}

export interface CatalogLiveReportOptions {
  /** The ledger as it stands now — read at every refresh, never copied. */
  ledger: () => SuiteLedger;
  /** The scenario a planned id belongs to (`PL_06`); the id's prefix otherwise. */
  scenarioOf?: ((id: string) => string | undefined) | undefined;
  /** The run log, when history is on — supplies the per-case explanations. */
  history?: RunHistory | null | undefined;
  /** Where a failure to write is reported. */
  onError?: ((message: string) => void) | undefined;
  /** Working directory the `reports/` folder is resolved under. */
  cwd?: string | undefined;
}

export class CatalogLiveReport {
  readonly #options: CatalogLiveReportOptions;
  /** Bundles this process produced, by planned id. */
  readonly #bundles = new Map<string, ProofBundle>();
  /** Bundles re-read from an earlier pass's proof file, by proof path. */
  readonly #fromDisk = new Map<string, ProofBundle | null>();
  /** History explanations, computed once per recorded bundle. */
  readonly #history = new Map<string, readonly string[]>();
  #inFlight: Promise<CatalogArtifacts | null> | null = null;
  #again = false;
  #final = false;
  #last: CatalogArtifacts | null = null;

  constructor(options: CatalogLiveReportOptions) {
    this.#options = options;
  }

  /** The artifacts of the most recent successful write. */
  get last(): CatalogArtifacts | null {
    return this.#last;
  }

  /**
   * A case finished in this process. Its bundle is the freshest evidence
   * there is, so it outranks whatever the ledger's proof path says.
   */
  record(name: string, bundle: ProofBundle | null): void {
    const id = caseIdOf(name);
    if (bundle === null) {
      this.#bundles.delete(id);
      this.#history.delete(id);
      return;
    }
    this.#bundles.set(id, bundle);
    this.#history.delete(id);
  }

  /**
   * Rewrite the report from the ledger as it stands. Concurrent calls
   * collapse into one more write after the current one; `final` marks the
   * run as over so the page stops reloading itself.
   */
  refresh(final = false): Promise<CatalogArtifacts | null> {
    if (final) this.#final = true;
    if (this.#inFlight !== null) {
      this.#again = true;
      return this.#inFlight.then(() => this.#last);
    }
    this.#inFlight = this.#write().finally(() => {
      this.#inFlight = null;
      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#inFlight;
  }

  /** Wait for every pending write — what the roll-up does before it prints paths. */
  async settle(): Promise<CatalogArtifacts | null> {
    while (this.#inFlight !== null) await this.#inFlight;
    return this.#last;
  }

  async #bundleOf(id: string): Promise<ProofBundle | null> {
    const fresh = this.#bundles.get(id);
    if (fresh !== undefined) return fresh;
    const proofPath = this.#options.ledger().outcomes[id]?.proofPath;
    if (typeof proofPath !== 'string' || proofPath === '') return null;
    if (!this.#fromDisk.has(proofPath)) {
      const bundle = await readFile(proofPath, 'utf8')
        .then((text) => JSON.parse(text) as ProofBundle)
        .catch(() => null);
      this.#fromDisk.set(proofPath, bundle);
    }
    return this.#fromDisk.get(proofPath) ?? null;
  }

  async #historyOf(bundle: ProofBundle): Promise<readonly string[]> {
    const history = this.#options.history;
    if (history === null || history === undefined) return [];
    const id = caseIdOf(bundle.name);
    const known = this.#history.get(id);
    if (known !== undefined) return known;
    const lines = await historyLinesFor(history, bundle);
    this.#history.set(id, lines);
    return lines;
  }

  async #write(): Promise<CatalogArtifacts | null> {
    try {
      const ledger = this.#options.ledger();
      const cases = await buildCatalogReportCases(
        ledger,
        (id) => this.#bundleOf(id),
        (id) => this.#options.scenarioOf?.(id) ?? scenarioFromId(id),
        (bundle) => this.#historyOf(bundle),
      );
      const input: CatalogReportInput = {
        title: ledger.title,
        runKey: ledger.runKey,
        generatedAt: ledger.generatedAt,
        cases,
        live: !this.#final,
        // Straight off the ledger, which is where the runner recorded it — so
        // a rebuilt report says the same thing as the live one, and a `report`
        // run months later still names the way back.
        ...(ledger.dbBaseline === undefined ? {} : { dbBaseline: ledger.dbBaseline }),
        // The run's own choice, off the ledger — so the live pages and a
        // rebuild months later are in the same language.
        ...(ledger.launch?.reportLang === undefined ? {} : { lang: ledger.launch.reportLang }),
      };
      this.#last = await writeCatalogArtifacts(input, this.#options.cwd);
      return this.#last;
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error));
      return null;
    }
  }
}
