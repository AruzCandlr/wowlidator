/**
 * Post-run error triage: when a case ends as a SYSTEM ERROR — not a verdict
 * about the application, not a test-failure — one small model call says WHICH
 * layer broke and, when it can, how to fix it.
 *
 * The distinction this exists to draw (be100 PL_07, 2026-08-28): PL_07's ten
 * cases all errored, and the reason was none of the three things the machinery
 * spent money assuming. The seeded plan the whole scenario asserts against —
 * `PL_07_01_02_03_04_05_06`, "QA-Make correction" — is not in the application
 * (the replica holds 75 real plans, all `TH_*`; this one, 0). So every case
 * reached Benefit Plans, the agent scrolled and reloaded for a row that was
 * never there, stalled five turns, and errored — PL_07_01 alone at 108 model
 * calls and $3.24. The healer cannot fix that, the generator did nothing wrong,
 * the application is working: the TEST CATALOG names data that does not exist.
 * Nothing in the run said so, so a person re-ran it.
 *
 * Five origins, and the fix that follows from each:
 *   - `test-catalog`  — the case, or its test data, is the problem: a record it
 *                       needs was never seeded, a precondition never holds, an
 *                       expectation names something the product never had.
 *   - `generator`     — the authored flow is wrong: a selector, route or value
 *                       invented rather than grounded in the evidence.
 *   - `agent`         — the navigation agent stalled or looped on a target that
 *                       the evidence says DOES exist — a real find-it failure.
 *   - `environment`   — the harness or its infra broke: a database that was
 *                       never configured, a provider that refused, a lost
 *                       browser. No verdict, and not anyone's flow.
 *   - `application`   — the app genuinely erred (a 500, a crash) in a way that
 *                       is a defect, not a missed assertion.
 *
 * It is a `healer`-role call by default — the small, fast, cheap diagnostic
 * model — given the error, the agent's own trail, the flow, the case and the
 * ground truth (declared routes, repository hints, documents). Deterministic
 * signals (`diagnosisSignals`) are computed first and handed over as facts, so
 * "the row the agent hunted for is a value no evidence mentions" is in the
 * prompt, not left for the model to notice. It never repairs anything and never
 * changes a verdict — it explains one, on `bundle.diagnosis`, in the run log
 * and in the report. `WOWLIDATOR_DIAGNOSE=off` turns it off.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import type { AgentRecord, ErrorDiagnosis, ProofBundle, ProofStep } from '../engine/proof-bundle.js';
import type { HealHintsProvider } from '../context/heal-hints.js';
import { selectorNames } from './dead-end-risk.js';
import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';

export type { ErrorDiagnosis } from '../engine/proof-bundle.js';

/** `WOWLIDATOR_DIAGNOSE=off` disables it; anything else keeps it on. */
export function diagnosisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WOWLIDATOR_DIAGNOSE'] ?? '').trim().toLowerCase() !== 'off';
}

export const ORIGINS = ['test-catalog', 'generator', 'agent', 'environment', 'application'] as const;
export type ErrorOrigin = (typeof ORIGINS)[number];

export interface DiagnosisRequest {
  caseName: string;
  /** The sheet's own words — what the case asked for. */
  caseText: string;
  bundle: ProofBundle;
  /** Page routes the repository declares; empty = no repository indexed. */
  declaredRoutes: readonly string[];
  /** The same repo/background hints the healer reads, for the failed page. */
  hints?: HealHintsProvider | undefined;
}

export interface DiagnosisResult {
  origin: ErrorOrigin;
  confidence: number;
  reasoning: string;
  /** A concrete fix, or '' when none is available (the honest empty). */
  fix: string;
  /** Who can act on the fix, for the reader: author / catalog / ops / nobody. */
  actionable: boolean;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface DiagnosisModel {
  readonly id: string;
  diagnose(request: DiagnosisRequest, signals: readonly string[]): Promise<DiagnosisResult>;
}

/* ------------------------------------------------------------ evidence */

/** The steps that broke on the harness — an `error`, not a failed assertion. */
export function erroredSteps(bundle: ProofBundle): ProofStep[] {
  return bundle.steps.filter((step) => !step.superseded && step.status === 'error');
}

/** The whole text a run's evidence could ground a target on. */
function evidenceText(request: DiagnosisRequest): string {
  const parts = [request.caseText, request.declaredRoutes.join(' ')];
  const failed = firstErrorStep(request.bundle);
  if (request.hints && failed) {
    const hint = request.hints({ url: failed.url ?? '', selector: failed.selector ?? '', ...(failed.intent === undefined ? {} : { intent: failed.intent }) });
    if (hint.repoHints) parts.push(hint.repoHints);
    if (hint.background) parts.push(hint.background);
  }
  return parts.join('\n').toLowerCase().replace(/\s+/g, ' ');
}

function firstErrorStep(bundle: ProofBundle): ProofStep | undefined {
  return erroredSteps(bundle)[0] ?? bundle.steps.find((s) => !s.superseded && s.status !== 'passed');
}

/** The targets an agent kept failing to find — the last selector in each try. */
function agentTargets(agent: AgentRecord | undefined): string[] {
  if (!agent) return [];
  const out: string[] = [];
  for (const action of agent.actions) {
    if (action.ok) continue;
    const m = /(?:no element mat.*?|matches )"([^"]+)"/.exec(action.error ?? '');
    if (m?.[1]) out.push(m[1]);
    else if (typeof action.selector === 'string' && action.selector !== '') out.push(action.selector);
  }
  return out;
}

/**
 * Facts about the error that need no model, each one a line the model is handed
 * as evidence. The load-bearing one is the last: an agent that stalled hunting
 * for a value NO evidence mentions is the PL_07 signature — a record the test
 * asserts exists but the application never had.
 */
export function diagnosisSignals(request: DiagnosisRequest): string[] {
  const signals: string[] = [];
  const bundle = request.bundle;
  const evidence = evidenceText(request);

  if (bundle.notes?.some((n) => /never configured|no database|db url|blocked \(not failed\)/i.test(n))) {
    signals.push('a note says the run wanted a resource that was not configured — points at environment, not a flow');
  }
  if (bundle.error && /provider|refused|quota|rate limit|breaker|usage cap/i.test(bundle.error)) {
    signals.push('the run error mentions the model provider — points at environment');
  }
  // A persona the run was not given (CG-05: `signIn` by label resolves
  // against `RunFlowOptions.personas`), or a fixture the harness could not
  // write (CG-19), is the RUN's configuration, never the case or the flow —
  // the fix is `--persona LABEL=email:password` or the fixture root, not a
  // re-author.
  for (const step of erroredSteps(bundle)) {
    if (/persona .* has no credentials|no credentials for persona|FixtureMissingError|fixture .* could not be written/i.test(step.error ?? '')) {
      signals.push(
        `step ${step.index} ${step.action}: ${(step.error ?? '').split('\n')[0]} — a persona or fixture the run was not configured with; points at environment (pass --persona LABEL=email:password / check the fixture root), not at the case`,
      );
      break;
    }
  }

  const stalls = erroredSteps(bundle).filter((s) => s.action === 'workflow' && /stalled|nothing advanced|no progress/i.test(s.error ?? ''));
  const missingTargets = new Set<string>();
  for (const step of stalls) {
    for (const target of agentTargets(step.agent)) {
      for (const name of selectorNames(target)) {
        const key = name.toLowerCase();
        if (key.length >= 3 && !evidence.includes(key)) missingTargets.add(name);
      }
    }
  }
  if (stalls.length > 0) {
    signals.push(`${stalls.length} workflow step(s) stalled — the agent could not reach what the flow named`);
  }
  if (missingTargets.size > 0) {
    signals.push(
      `the agent kept hunting for ${[...missingTargets].slice(0, 4).map((t) => `"${t}"`).join(', ')} — value(s) that appear in NO evidence (case, routes, repository, documents): the test may name data the application does not have`,
    );
  }

  // A stall whose target IS in the evidence is the opposite: a real find-it
  // failure the agent owns.
  const foundButUnreached = stalls.length > 0 && missingTargets.size === 0;
  if (foundButUnreached) signals.push('the stalled agent hunted for controls the evidence DOES describe — a navigation failure, not missing data');

  for (const step of erroredSteps(bundle)) {
    if (step.action.startsWith('expect') && /no dialog|no modal|not.*visible/i.test(step.error ?? '')) {
      signals.push(`step ${step.index}: an assertion errored because an earlier step never opened what it needed — a cascade from the first error, not its own fault`);
      break;
    }
  }
  return signals.slice(0, 10);
}

/* ------------------------------------------------------------- the model */

const DiagnosisSchema = z.object({
  origin: z.enum(ORIGINS).describe('Where the system error came from.'),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().describe('One or two sentences, citing the evidence: a step, the agent trail, a route.'),
  fix: z.string().describe('A concrete fix if one is available, else an empty string. Name the file, the seed, the setting.'),
  actionable: z.boolean().describe('True if a person can act on the fix now (re-author, seed the data, set the env); false if it is only an explanation.'),
});

const SYSTEM_PROMPT = `You triage a UI test that ended as a SYSTEM ERROR — the harness stopped with no verdict about
the application. You decide WHICH layer broke, from the error, the navigation agent's own trail,
the authored flow, the case the sheet asked for, and the ground truth (the routes the codebase
declares, the repository hints, the documents). You do not fix anything; you name the cause and,
when you can, the fix.

The five origins:
- test-catalog: the CASE or its TEST DATA is the problem. A record the flow asserts against was
  never seeded or was deleted; a precondition never holds; an expectation names a value, a plan, a
  user that the product never had. The signature: the agent hunts, reloads and scrolls for a
  specific value (an ID, a name) that appears in NO evidence, and every downstream assertion
  cascades from never finding it. The fix is to seed the data or correct the case — NOT to touch
  the flow or the app.
- generator: the authored FLOW is wrong. A selector, a route, or a typed value the author invented
  instead of grounding in the evidence — a control the page never had, a goto to an undeclared
  path. The fix is to re-author (\`run --repair\`, or fix the flow file).
- agent: the navigation AGENT stalled or looped on a target the evidence says DOES exist. A real
  find-it failure — the control is there, the agent could not reach it. The fix is agent-side
  (retry, a better capture, --repair-investigate).
- environment: the harness or its infra broke. A database never configured, a provider that
  refused or hit a quota, a lost browser, a usage cap. Not anyone's flow. The fix is ops: set the
  env, add a key, start the service.
- application: the app genuinely erred — a 500, a crash, a broken page — in a way that is a real
  defect, not a missed assertion.

Weigh the SIGNALS marked as facts above your reading of prose. A cascade (an assertion that
errored only because an earlier step never opened its dialog) is attributed to the FIRST error, not
the cascade. When two origins are plausible, pick the one whose fix would actually make the run
pass, and say the other in the reasoning.

${DETERMINISM_RULES}

${procedure('HOW TO TRIAGE', [
  'Find the FIRST errored step and read its error and, if it is a workflow, the agent trail under it.',
  'Ask what the step needed and whether the evidence shows it exists: a value nowhere in the evidence points at test-catalog; a control the evidence describes but the agent missed points at agent; an undeclared route or invented selector points at generator.',
  'Check the signals for environment markers (unconfigured resource, provider refusal) — those outrank a flow explanation.',
  'Set origin and confidence; write a fix ONLY if one is available, name what to change, and set actionable accordingly. If there is no fix, leave it empty and say why in the reasoning.',
])}`;

function clip(text: string, max: number): string {
  const folded = (text ?? '').replace(/\r/g, '').trim();
  return folded.length <= max ? folded : folded.slice(0, max - 1) + '…';
}

export function buildDiagnosisPrompt(request: DiagnosisRequest, signals: readonly string[]): string {
  const bundle = request.bundle;
  const lines: string[] = [];
  lines.push(`CASE: ${request.caseName}`);
  lines.push(clip(request.caseText, 1_500));
  lines.push('');
  lines.push(`RUN STATUS: ${bundle.status}`);
  if (bundle.error) lines.push(`RUN ERROR: ${clip(bundle.error, 500)}`);
  if (bundle.notes?.length) lines.push(`NOTES: ${bundle.notes.map((n) => clip(n, 160)).join(' | ')}`);
  lines.push('');
  lines.push('ERRORED STEPS (harness broke — no verdict):');
  for (const step of erroredSteps(bundle).slice(0, 6)) {
    lines.push(`- step ${step.index} ${step.action}${step.selector ? ' ' + step.selector : ''}${step.intent ? ` — ${clip(step.intent, 100)}` : ''}`);
    lines.push(`    error: ${clip(step.error ?? '', 260)}`);
    if (step.agent) {
      lines.push(`    agent goal: ${clip(step.agent.goal, 160)}`);
      lines.push(`    agent ended: ${clip(step.agent.summary, 200)}`);
      const trail = step.agent.actions.slice(-5).map((a) => `${a.ok ? '✓' : '✗'} ${a.action} ${clip(String(a.selector ?? a.error ?? ''), 70)}`);
      if (trail.length) lines.push(`    last actions: ${trail.join(' | ')}`);
    }
  }
  const failedAsserts = bundle.steps.filter((s) => !s.superseded && (s.status === 'failed' || s.status === 'dead-end')).slice(0, 4);
  if (failedAsserts.length) {
    lines.push('');
    lines.push('ALSO (test-failures downstream — likely cascades):');
    for (const step of failedAsserts) lines.push(`- step ${step.index} ${step.action} ${step.selector ?? ''} — ${clip((step.error ?? '').split('\n')[0] ?? '', 120)}`);
  }
  lines.push('');
  lines.push('SIGNALS (computed from the run — facts):');
  lines.push(...(signals.length ? signals.map((s) => `- ${s}`) : ['- none']));
  if (request.declaredRoutes.length) {
    lines.push('');
    lines.push(`DECLARED PAGE ROUTES (${request.declaredRoutes.length}): ${request.declaredRoutes.slice(0, 50).join('  ')}`);
  }
  const failed = firstErrorStep(bundle);
  if (request.hints && failed) {
    const hint = request.hints({ url: failed.url ?? '', selector: failed.selector ?? '', ...(failed.intent === undefined ? {} : { intent: failed.intent }) });
    if (hint.repoHints) { lines.push(''); lines.push('REPOSITORY (for the failed page):'); lines.push(clip(hint.repoHints, 2_000)); }
    if (hint.background) { lines.push(''); lines.push('BACKGROUND:'); lines.push(clip(hint.background, 3_000)); }
  }
  return lines.join('\n');
}

export interface LlmDiagnosisModelOptions {
  model?: LanguageModel | undefined;
  id?: string | undefined;
  factory?: LlmFactory | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
}

/** A `healer`-role call by default: the small, fast, cheap diagnostic model. */
export class LlmDiagnosisModel implements DiagnosisModel {
  readonly #source: ModelSource;
  readonly #explicitId: string | undefined;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmDiagnosisModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:diagnosis';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'healer' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 500;
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('healer').id : 'custom:diagnosis';
  }

  async diagnose(request: DiagnosisRequest, signals: readonly string[]): Promise<DiagnosisResult> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: DiagnosisSchema,
      system: SYSTEM_PROMPT,
      prompt: buildDiagnosisPrompt(request, signals),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
      task: 'diagnosis',
    });
    return {
      origin: object.origin,
      confidence: Math.max(0, Math.min(1, object.confidence / 100)),
      reasoning: object.reasoning.trim(),
      fix: object.fix.trim(),
      actionable: object.actionable && object.fix.trim() !== '',
      inputTokens,
      outputTokens,
    };
  }
}

/* ------------------------------------------------------------ diagnosing */

export interface DiagnoseOptions {
  model: DiagnosisModel;
  log?: ((line: string) => void) | undefined;
}

/**
 * Only a SYSTEM ERROR is diagnosed — a run that delivered no verdict about the
 * application. A test-failure (`failed`, `dead-end`) proved something and is
 * not this function's business; passing/needs-review even less so. Returns null
 * for those, and for a model call that fails (logged once): a diagnosis that
 * cannot be made is a run that reports its error plainly, exactly as before.
 */
export async function diagnoseError(request: DiagnosisRequest, options: DiagnoseOptions): Promise<ErrorDiagnosis | null> {
  if (request.bundle.status !== 'error') return null;
  const signals = diagnosisSignals(request);
  try {
    const result = await options.model.diagnose(request, signals);
    return {
      origin: result.origin,
      confidence: result.confidence,
      reasoning: result.reasoning,
      fix: result.fix === '' ? null : result.fix,
      actionable: result.actionable,
      signals,
      model: options.model.id,
      at: new Date().toISOString(),
      ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    options.log?.(`  ! error diagnosis skipped for ${request.caseName}: ${message} — the run reports its error plainly`);
    return null;
  }
}

const ORIGIN_LABEL: Record<string, string> = {
  'test-catalog': 'the test catalog (the case or its data)',
  generator: 'the generator (the authored flow)',
  agent: 'the navigation agent',
  environment: 'the environment (harness or infra)',
  application: 'the application',
};

/** One line for the run log and the note the proof carries. */
export function describeDiagnosis(d: ErrorDiagnosis): string {
  const pct = Math.round(d.confidence * 100);
  const head = `system error diagnosed: ${ORIGIN_LABEL[d.origin] ?? d.origin} (${pct}%) — ${d.reasoning}`;
  return d.fix ? `${head}  fix: ${d.fix}` : `${head}  (no fix available)`;
}
