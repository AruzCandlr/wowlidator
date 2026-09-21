/**
 * The catalog generator for the indexed (Jev) engine — programmatic first.
 *
 * Plan: `plans/20260918155200-jev-catalog-generator.md` (the Lavish plan of
 * 2026-09-18, decisions A / LLM-for-unread-lines / automatic selection / one
 * leg per sheet step). The engine side landed the same day
 * (`src/orchestrator/jev-policy.ts`); this is the input side.
 *
 * **What a Jev-consumable flow is.** Not a new file format: an ordinary flow
 * whose body is mostly `workflow` goals, written in the grammar the engine
 * reads at $0 — `set Field = "value"` pairs `goalOutcomes` parses (so
 * TYPE_TEXT / SELECT never pay the text helper), a menu chain
 * `#walkMenuPath` walks, a URL `goalDestination` ends the leg on. Jev is
 * asked only WHICH control; the values and the destination are the sheet's.
 *
 * **What is programmatic, and what is not.** Every reader here already
 * exists in `src/catalog/test-case-table.ts` and is applied to the described
 * case (`describeCase`) the author already renders — the persona tokens, the
 * menu path, the Test data pairs, the numbered Steps, the Expected lines,
 * the record-only markers. From those:
 *
 * - the persona token → `signIn as: <LABEL>` in setup (a token in a later
 *   step is a hand-off: another `signIn` before that leg);
 * - the menu path / destination → the first leg;
 * - each numbered step → one `workflow` leg, the step verbatim, annotated
 *   `(test step N)`, carrying the Test data pairs whose field the step names
 *   (pairs no step names ride the first leg that asks for input), each pair
 *   resolved through the same $0 value sources the LLM path uses (relative
 *   dates, blank words, unique-per-run keys, written values);
 * - each Expected line with a quoted literal → `expectVisible text="…"`, a
 *   path → `expectUrl`; a line with neither is UNREAD.
 *
 * A row with unread lines pays one model call — the LLM author, asked for
 * those lines only, with the programmatic steps stated as already written —
 * and only the assertion steps of its answer are kept, so the model can
 * never rewrite a leg. A row whose every line is readable costs no model
 * call at all. Selection is `authorModeOf` in `src/cli/runtime.ts`.
 *
 * Everything after `author()` is `FlowAuthor`'s as before: the lints (one
 * of which, `workflowOverDeclaredControls`, is withheld under
 * `FlowAuthorOptions.indexed` — a goal naming a declared control is the
 * point here), the reviewer, the risk judge, the refusal ledger, rounds and
 * unique keys. This file writes steps; it never touches a page or a model
 * except through the fallback it is handed.
 */

import type { FlowStep } from '../engine/runner.js';
import { expectedLines, sectionOf, type ExpectedLine } from '../catalog/test-case-table.js';
import { menuPathOf } from '../orchestrator/agent-guards.js';
import { NOT_A_CONTROL, goalOutcomes, verificationOnlyGoal } from '../orchestrator/goal-evidence.js';
import { AUTHORING, LOGIN_URL_PATTERN } from './value-rules.js';
import { PLACEHOLDER_TOKEN, resolveValues, type TestDataPair } from './value-resolution.js';
import {
  testDataPairsOfCaseText,
  type AuthorRequest,
  type AuthorResult,
  type FlowAuthorModel,
} from './flow-author.js';

/** `<HR_ADMIN_ACCOUNT>` — the sheet's persona token, the label a `signIn` names. */
const PERSONA_TOKEN = /<([A-Z][A-Z0-9_]*_ACCOUNT)>/g;
/** A numbered sheet step: `1. Open Hiring`, `3) กรอก …`. */
const NUMBERED = /^\s*(\d+)[.)]\s*(.*\S)\s*$/;
/** A step that is the sign-in itself, in the sheets' own words (`authoring.script.signIn`). */
const LOGIN_STEP = AUTHORING.script.signIn;
/** A URL or an absolute path an Expected line names. */
const URL_OR_PATH = /https?:\/\/[^\s)"'<>]+|(?<![\w/])\/[a-z][\w\-/]*(?:\?[^\s)"'<>]*)?/i;
/** A literal the Expected line quotes, any quote style. */
const QUOTED = /"([^"\n]{1,120})"|“([^”\n]{1,120})”|'([^'\n]{1,120})'/g;
/** Words that key a Test data pair to a step: the pair's field words. */
const words = (text: string): string[] => text.toLowerCase().split(/[\s/()]+/).filter((w) => w.length > 1);

export interface CatalogLeg {
  /** The sheet step's number. */
  step: number;
  /** The goal as written for the engine. */
  goal: string;
  /** The pairs this leg carries, resolved. */
  pairs: readonly TestDataPair[];
}

export interface CatalogPlan {
  title: string;
  setup: FlowStep[];
  steps: FlowStep[];
  legs: CatalogLeg[];
  /** Expected lines the readers could not turn into an assertion. */
  unread: ExpectedLine[];
  /** One line per decision, for the rationale. */
  rationale: string[];
}

export interface CatalogPlanOptions {
  /** The persona labels the run holds credentials for. */
  personas?: readonly string[] | undefined;
  /** Whether the run has a `--as` account — registered as the `DEFAULT` persona by `runPersonas`. */
  hasCredentials?: boolean | undefined;
  /**
   * The sign-in page a `signIn` opens when the browser is not on one — the
   * run's start URL when it is a sign-in URL. Without it the engine refuses
   * the step ("no sign-in page to open — name one with `url`"), which is
   * how the first HUMI SIT run ended at step 1 (2026-09-18).
   */
  signInUrl?: string | undefined;
  now?: Date | undefined;
  runKey?: string | undefined;
  caseId?: string | undefined;
  testDataPairs?: readonly TestDataPair[] | undefined;
}

/**
 * A pair as the engine's `goalOutcomes` reads it: `"Field" = "value"`. Both
 * halves quoted — a bare control stops at a slash, a digit or a Thai phase
 * word, and the sheets' keys carry all three (`Country / Province /
 * District`, `ตารางกำหนด Time Status`); the quoted alternation reads the
 * whole key. Measured on the EC catalog: 36 of 144 legs lost a pair bare,
 * none quoted.
 */
export function pairClause(pair: TestDataPair): string {
  return `${JSON.stringify(pair.key)} = ${JSON.stringify(pair.value)}`;
}

/** The engine's quoted-control alternation reads up to this many characters. */
const CONTROL_CHARS_MAX = 60;
/**
 * A Test data key that is the sheet's own routing metadata, not a field on
 * the page: every EC row writes `Entry Route = Keyin` and `Menu = Team >
 * Probation Reviews` beside its real pairs. The engine's `NOT_A_CONTROL`
 * screens the generic ones (menu, login, url…); the sheets' own words join it.
 */
const SHEET_META_KEY = /^(?:entry\s*route|module|screen|sheet|tab)$/iu;

/**
 * The pairs a goal may carry: a key the engine can read back, a value that
 * is not blank. A blank is what the sheet said to leave empty — nothing to
 * type, and `= ""` parses as no pair; a key longer than the engine reads is
 * noted rather than half-read.
 */
export function writablePairs(pairs: readonly TestDataPair[]): { kept: TestDataPair[]; blank: TestDataPair[]; unreadable: TestDataPair[]; overridden: TestDataPair[]; meta: TestDataPair[]; tokens: TestDataPair[] } {
  const kept: TestDataPair[] = [];
  const blank: TestDataPair[] = [];
  const unreadable: TestDataPair[] = [];
  const overridden: TestDataPair[] = [];
  const meta: TestDataPair[] = [];
  const tokens: TestDataPair[] = [];
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (NOT_A_CONTROL.test(key) || SHEET_META_KEY.test(key)) meta.push(pair);
    // A token no $0 source resolved (`<NON_EXISTING_EMPLOYEE_ID>`) is never
    // typed: the LLM path's repo/db sources are the ones that answer it.
    else if (PLACEHOLDER_TOKEN.test(pair.value)) tokens.push(pair);
    else if (pair.value.trim() === '') blank.push(pair);
    else if (pair.key.length > CONTROL_CHARS_MAX || pair.value.length > CONTROL_CHARS_MAX) unreadable.push(pair);
    else {
      // The sheet writes a key twice — a later line overriding an earlier
      // one (`Branch code = TA57_1001` then `T153_1733`), or the same value
      // spelt twice. The engine reads one control per name; the LAST line
      // is the sheet's word, and the earlier one is noted.
      const at = kept.findIndex((k) => k.key.toLowerCase() === pair.key.toLowerCase());
      if (at !== -1) {
        if (kept[at]!.value !== pair.value) overridden.push(kept[at]!);
        kept.splice(at, 1);
      }
      kept.push(pair);
    }
  }
  return { kept, blank, unreadable, overridden, meta, tokens };
}

/** A sheet step: its numbered line, and the block of bullets written under it. */
export interface SheetStep {
  n: number;
  text: string;
  /** The numbered line plus the unnumbered lines that follow it, until the next number. */
  block?: string | undefined;
}

/**
 * The sheet steps with their pairs attached, and the pairs that are the
 * application's to fill in.
 *
 * A pair rides the first step whose BLOCK names its field (either way round,
 * whole words) — the sheet lists a step's fields in the bullets under its
 * number ("2. กรอกข้อมูล Identity" / "- กรอก Salutation, First Name … Hire Date
 * และ Event Reason"), so the numbered line alone names almost nothing
 * (HIR-EC-001, 2026-09-18: 29 of 31 pairs were strays). A verification-only
 * step is never a home: "8. ตรวจสอบ Employee ID / Status / Employee Group" names
 * the fields it reads, not fields to key.
 *
 * A pair no step names, but an Expected LINE that says the application
 * produces the value does (`AUTHORING.derived`: "ระบบดึงข้อมูลจาก Department
 * ได้แก่ Cost Center / SSO Location …", "ระบบ Auto-Derive … O.T. Flag = Yes"), is
 * DERIVED: setting it would have the agent type into a read-only field, so
 * it is left to the assertions. An Expected line that merely echoes a keyed
 * value ("Hire Date = Today ตามค่าที่กรอก", HIR-EC-002) marks nothing. A pair
 * named nowhere rides the first step that asks for input, else the first
 * step.
 */
export function attachPairs(
  steps: readonly SheetStep[],
  pairs: readonly TestDataPair[],
  expected = '',
): { byStep: Map<number, TestDataPair[]>; derived: TestDataPair[] } {
  const byStep = new Map<number, TestDataPair[]>();
  const derived: TestDataPair[] = [];
  const push = (n: number, pair: TestDataPair): void => {
    (byStep.get(n) ?? byStep.set(n, []).get(n)!).push(pair);
  };
  const names = (field: string[], text: string): boolean => {
    const lower = text.toLowerCase();
    return field.length > 0 && field.every((w) => lower.includes(w));
  };
  // A sign-in step takes no pairs either — and its bullet may say "Manual
  // Key-in", which reads as an input verb.
  const homes = steps.filter((s) => !verificationOnlyGoal(s.text) && !LOGIN_STEP.test(s.text));
  // The SOURCE a value is pulled from is the tester's input, not a derived
  // value: in "ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / …" only the
  // list after the marker is the application's. The "จาก/from <source>"
  // clause is dropped before a field is matched against the line.
  const derivedLines = expected
    .split('\n')
    .filter((line) => AUTHORING.derived.test(line))
    .map((line) => line.replace(/(?:จาก|from)\s+[^\n]*?(?=ได้แก่|including|such as|:|$)/giu, ' '));
  const inputStep = homes.find((s) => INPUT_WORDS.test(s.block ?? s.text)) ?? steps[0];
  for (const pair of pairs) {
    const field = words(pair.key);
    const home = homes.find((s) => names(field, s.block ?? s.text));
    if (home !== undefined) push(home.n, pair);
    else if (derivedLines.some((line) => names(field, line))) derived.push(pair);
    else if (inputStep !== undefined) push(inputStep.n, pair);
  }
  return { byStep, derived };
}

/** The sheets' input verbs — the step a stray pair belongs to. */
const INPUT_WORDS = /กรอก|คีย์|ระบุ|เลือก|ใส่|\b(?:fill|enter|type|key[- ]?in|input|select|choose)\b/iu;

/**
 * The plan for one described case, at $0. Async only for the value
 * resolver's date arithmetic; no model, no page.
 */
export async function planCatalogCase(caseText: string, options: CatalogPlanOptions = {}): Promise<CatalogPlan> {
  const rationale: string[] = [];
  const title = (caseText.split('\n')[0] ?? '').trim();
  const setup: FlowStep[] = [];
  const steps: FlowStep[] = [];
  const legs: CatalogLeg[] = [];

  // --- who signs in ---------------------------------------------------------
  const personaSection = sectionOf(caseText, 'login / persona') ?? '';
  const stepsSection = sectionOf(caseText, 'steps') ?? '';
  const tokensIn = (text: string): string[] => [...new Set([...text.matchAll(PERSONA_TOKEN)].map((m) => m[1]!))];
  const firstLabel = tokensIn(personaSection)[0] ?? tokensIn(stepsSection)[0] ?? options.personas?.[0];
  const signInUrl = options.signInUrl === undefined ? {} : { url: options.signInUrl };
  if (firstLabel !== undefined) {
    setup.push({ action: 'signIn', as: firstLabel, ...signInUrl, intent: `sign in as ${firstLabel} (the sheet's Login / persona)` });
    rationale.push(`setup: signIn as ${firstLabel} — from the persona token`);
  } else if (options.hasCredentials === true) {
    // `runPersonas` registers the `--as` account under this label, so the
    // flow file names no email.
    setup.push({ action: 'signIn', as: 'DEFAULT', ...signInUrl, intent: "sign in as the run's --as account" });
    rationale.push("setup: signIn as DEFAULT — the run's --as account; the row names no persona");
  } else {
    rationale.push('setup: no sign-in — the row names no persona and the run has no --as account');
  }

  // --- the sheet steps, one leg each -------------------------------------
  const numbered: SheetStep[] = [];
  for (const line of stepsSection.split('\n')) {
    const m = NUMBERED.exec(line);
    if (m !== null) numbered.push({ n: Number(m[1]), text: m[2]!, block: m[2]! });
    else if (line.trim() !== '' && numbered.length > 0) numbered[numbered.length - 1]!.block += `\n${line.trim()}`;
  }
  const pairs = await resolvedPairs(caseText, options);
  const expectedText = sectionOf(caseText, 'expected') ?? '';
  const { byStep: attached, derived } = attachPairs(numbered, pairs, expectedText);
  if (derived.length > 0) {
    rationale.push(
      `test data: ${derived.map((p) => p.key).join(', ')} — named by no step and by the Expected output: ` +
        "the application's to fill in, left to the assertions, never set",
    );
  }
  const menuLine = sectionOf(caseText, 'menu path')?.trim() ?? '';
  const destinationLine = sectionOf(caseText, 'destination')?.trim() ?? '';
  const destinationUrl = URL_OR_PATH.exec(destinationLine)?.[0];
  let menuWritten = false;
  let signedInAs = firstLabel;

  for (const step of numbered) {
    const tokens = tokensIn(step.text);
    // A hand-off: the step names another account → a signIn, not a leg.
    if (tokens.length > 0 && LOGIN_STEP.test(step.text)) {
      const label = tokens[0]!;
      if (label !== signedInAs) {
        steps.push({ action: 'signIn', as: label, ...signInUrl, intent: `test step ${step.n}: ${step.text}` });
        rationale.push(`step ${step.n}: signIn as ${label} — a hand-off the sheet writes`);
        signedInAs = label;
      } else {
        rationale.push(`step ${step.n}: the sign-in already in setup`);
      }
      continue;
    }
    if (LOGIN_STEP.test(step.text) && tokens.length === 0 && setup.length > 0 && legs.length === 0) {
      rationale.push(`step ${step.n}: the sign-in already in setup`);
      continue;
    }
    // A verify-only step is answered by the Expected assertions, never by a
    // leg: the engine hands a verification goal off to the next assertion.
    if (verificationOnlyGoal(step.text) && !(attached.get(step.n)?.length)) {
      rationale.push(`step ${step.n}: a verification — proved by the Expected assertions, not a leg`);
      continue;
    }
    const { kept: own, blank, unreadable, overridden, meta, tokens: placeholders } = writablePairs(attached.get(step.n) ?? []);
    if (placeholders.length > 0) rationale.push(`step ${step.n}: ${placeholders.map((p) => `${p.key} = ${p.value}`).join(', ')} is an unresolved token — not typed`);
    if (blank.length > 0) rationale.push(`step ${step.n}: ${blank.map((p) => p.key).join(', ')} left blank, as the sheet says`);
    if (overridden.length > 0) rationale.push(`step ${step.n}: ${overridden.map((p) => `${p.key} = ${JSON.stringify(p.value)}`).join(', ')} overridden by a later line of the sheet`);
    if (meta.length > 0) rationale.push(`step ${step.n}: ${meta.map((p) => p.key).join(', ')} is the sheet's own metadata, not a field — not written`);
    if (unreadable.length > 0) rationale.push(`step ${step.n}: ${unreadable.map((p) => p.key).join(', ')} too long for a goal pair — not written`);
    const goalMenu = menuPathOf(step.text) !== null;
    let goal = step.text;
    // The row's menu path rides the first navigating leg, once, in the
    // shape the walker reads; a stated destination ends that leg.
    if (!menuWritten && menuLine !== '' && !goalMenu) {
      goal = `${goal} — open ${menuLine} via the menu`;
      menuWritten = true;
      rationale.push(`step ${step.n}: carries the menu path ${menuLine}`);
    } else if (goalMenu) {
      menuWritten = true;
    }
    if (own.length > 0) goal = `${goal}: set ${own.map(pairClause).join(', ')}`;
    if (destinationUrl !== undefined && menuWritten && !legs.some((l) => l.goal.includes(destinationUrl))) {
      goal = `${goal}, ending on ${destinationUrl}`;
    }
    goal = `${goal} (test step ${step.n})`;
    steps.push({ action: 'workflow', goal });
    legs.push({ step: step.n, goal, pairs: own });
    rationale.push(`step ${step.n}: one workflow leg${own.length > 0 ? `, ${own.length} pair(s) from Test data` : ''}`);
  }
  // A row with a menu path and no navigating step still needs to get there.
  if (!menuWritten && menuLine !== '' && legs.length === 0) {
    const goal = `Open ${menuLine} via the menu${destinationUrl === undefined ? '' : `, ending on ${destinationUrl}`}`;
    steps.unshift({ action: 'workflow', goal });
    legs.unshift({ step: 0, goal, pairs: [] });
    rationale.push('menu: one navigating leg from the Menu column');
  }
  // Pairs no step carried (a row with no numbered steps): one key-in leg.
  const carried = new Set([...[...attached.values()].flat(), ...derived]);
  const stray = writablePairs(pairs.filter((p) => !carried.has(p))).kept;
  if (stray.length > 0) {
    const goal = `Enter the test data: set ${stray.map(pairClause).join(', ')}`;
    steps.push({ action: 'workflow', goal });
    legs.push({ step: 0, goal, pairs: stray });
    rationale.push(`test data: ${stray.length} pair(s) no step named ride one key-in leg`);
  }

  // --- the Expected lines --------------------------------------------------
  const unread: ExpectedLine[] = [];
  const expectedSection = (sectionOf(caseText, 'expected') ?? '').replace(/\[RECORD ONLY\]\s*/g, '');
  for (const line of expectedLines(expectedSection)) {
    const label = line.no === null ? line.text : `${line.no} ${line.text}`;
    if (line.observeOnly) {
      unread.push(line);
      rationale.push(`expected ${label}: record-only — left to the LLM author (a capture needs a selector)`);
      continue;
    }
    const literals = [...line.text.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim()).filter((t) => t !== '');
    const path = URL_OR_PATH.exec(line.text)?.[0];
    if (literals.length > 0) {
      for (const literal of literals) {
        steps.push({ action: 'expectVisible', selector: `text=${JSON.stringify(literal)}`, intent: `expected ${label}` });
      }
      rationale.push(`expected ${label}: ${literals.length} quoted literal(s) → expectVisible`);
    } else if (path !== undefined && !LOGIN_URL_PATTERN.test(path)) {
      steps.push({ action: 'expectUrl', value: path.startsWith('http') ? new URL(path).pathname : path, intent: `expected ${label}` });
      rationale.push(`expected ${label}: a path → expectUrl`);
    } else {
      unread.push(line);
      rationale.push(`expected ${label}: no literal to quote — left to the LLM author`);
    }
  }

  return { title, setup, steps, legs, unread, rationale };
}

/**
 * The Test data pairs with the $0 value sources applied — relative dates,
 * blank words, unique-per-run keys, a value written beside a remark — by
 * running the existing resolver over one synthetic `fill` per pair. No
 * model (`model: null`), no database: the sources that need either are the
 * LLM path's and are not paid for a goal.
 */
async function resolvedPairs(caseText: string, options: CatalogPlanOptions): Promise<TestDataPair[]> {
  const pairs = options.testDataPairs ?? testDataPairsOfCaseText(caseText);
  if (pairs.length === 0) return [];
  const synthetic: FlowStep[] = pairs.map((pair) => ({
    action: 'fill',
    selector: `role=textbox[name=${JSON.stringify(pair.key)} i]`,
    value: pair.value,
  }));
  const outcome = await resolveValues([], synthetic, {
    caseText,
    model: null,
    testDataPairs: pairs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.runKey === undefined ? {} : { runKey: options.runKey }),
    ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
  }).catch(() => null);
  if (outcome === null) return [...pairs];
  // Only the sources that READ the sheet may rewrite a value: a relative
  // date computed, a key made unique to the run, a value written beside a
  // remark or a blank word. The generated stand-in (`candidateFor`) is the
  // LLM path's flagged last resort and never belongs in a goal unflagged —
  // measured on the EC catalog it put `Sub-District = 29999999` into a leg.
  const readable = new Set(['relative-date', 'unique-per-run', 'test-data']);
  const byIndex = new Map<number, string>();
  for (const one of outcome.resolved) {
    if (one.need.section === 'steps' && readable.has(one.source.kind)) byIndex.set(one.need.index, one.value);
  }
  return pairs.map((pair, i) => {
    const value = byIndex.get(i);
    return value === undefined ? pair : { ...pair, value };
  });
}

/** The assertion-shaped actions the fallback's answer may contribute. */
const ASSERTION_ACTIONS: ReadonlySet<string> = new Set([
  'expectText', 'expectVisible', 'expectHidden', 'expectValue', 'expectCount', 'expectAttribute', 'expectUrl',
  'expectEnabled', 'expectDisabled', 'expectModal', 'expectAnyVisible', 'expectFieldError', 'saveText', 'saveCount', 'snapshot',
]);

export interface JevCatalogAuthorModelOptions {
  /** The LLM author, asked for the unread Expected lines only. Absent: unread lines are noted and left. */
  fallback?: FlowAuthorModel | undefined;
  onLog?: ((line: string) => void) | undefined;
}

export class JevCatalogAuthorModel implements FlowAuthorModel {
  readonly #fallback: FlowAuthorModel | undefined;
  readonly #onLog: ((line: string) => void) | undefined;

  constructor(options: JevCatalogAuthorModelOptions = {}) {
    this.#fallback = options.fallback;
    this.#onLog = options.onLog;
  }

  get id(): string {
    return this.#fallback === undefined ? 'catalog:jev' : `catalog:jev+${this.#fallback.id}`;
  }

  async author(request: AuthorRequest): Promise<AuthorResult> {
    const caseText = request.caseText;
    if (caseText === undefined) {
      // Not a catalog row: nothing to read programmatically. The LLM author
      // writes it, exactly as it would have.
      if (this.#fallback === undefined) throw new Error('the jev catalog author needs a catalog row (caseText) or a fallback model');
      return await this.#fallback.author(request);
    }
    const plan = await planCatalogCase(caseText, {
      personas: request.personas === undefined ? undefined : Object.keys(request.personas),
      hasCredentials: request.credentials !== undefined,
      // The page the author was pointed at: a catalog run starts on the
      // sign-in page, and that is the page a `signIn` opens.
      signInUrl: request.url !== undefined && LOGIN_URL_PATTERN.test(request.url) ? request.url : undefined,
      now: request.now,
      runKey: request.runKey,
      caseId: request.caseId,
      testDataPairs: request.testDataPairs,
    });
    this.#onLog?.(`  jev author: ${plan.legs.length} leg(s), ${plan.steps.length - plan.legs.length} assertion(s), ${plan.unread.length} unread Expected line(s)`);
    let steps = plan.steps;
    let notes = '';
    let tokens: { inputTokens?: number | undefined; outputTokens?: number | undefined } = {};
    if (plan.unread.length > 0 && this.#fallback !== undefined) {
      const written = plan.steps.map((s, i) => `  ${i + 1}. ${describeStep(s)}`).join('\n');
      const lines = plan.unread.map((l) => `  - ${l.no === null ? '' : `${l.no} `}${l.text}${l.observeOnly ? ' [RECORD ONLY]' : ''}`).join('\n');
      // The ROW, not the whole prompt: the retrieved documents and the
      // repository slice are what a full authoring call reads to write a
      // journey; an assertion for one Expected line needs the row and the
      // trees the request already carries. Measured on the fixture catalog:
      // the full prompt made each of these asks 18-37k input tokens.
      const ask =
        `${caseText}\n\nALREADY WRITTEN — do not rewrite, repeat or replace any of these steps (they run before your steps):\n${written}\n\n` +
        `WRITE ONLY the assertion steps (expectText / expectVisible / expectHidden / expectValue / expectCount / expectUrl / expectAnyVisible / saveText) ` +
        `that prove these Expected lines, against the page the steps above end on:\n${lines}\n` +
        'Every step you write must be an assertion or a capture. No navigation, no input, no workflow.';
      this.#onLog?.(`  jev author: asking ${this.#fallback.id} for ${plan.unread.length} unread Expected line(s) only`);
      const answer = await this.#fallback.author({ ...request, prompt: ask, singleCase: true });
      const kept = answer.steps.filter((s) => ASSERTION_ACTIONS.has(s.action));
      const dropped = answer.steps.length - kept.length;
      steps = [...plan.steps, ...kept];
      notes = [answer.notes, dropped > 0 ? `${dropped} non-assertion step(s) the model wrote for the unread lines were dropped` : ''].filter((n) => n !== '').join(' · ');
      tokens = { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };
      plan.rationale.push(`unread: ${kept.length} assertion(s) from ${this.#fallback.id}${dropped > 0 ? `, ${dropped} other step(s) dropped` : ''}`);
    } else if (plan.unread.length > 0) {
      notes = `${plan.unread.length} Expected line(s) had no literal to quote and no model to ask: ${plan.unread.map((l) => l.text).join(' | ')}`;
    }
    return {
      name: plan.title,
      rationale: plan.rationale.join('\n'),
      setup: plan.setup,
      steps,
      cases: [{ name: plan.title, steps }],
      teardown: [],
      notes,
      droppedSteps: 0,
      ...tokens,
    };
  }
}

function describeStep(step: FlowStep): string {
  switch (step.action) {
    case 'workflow':
      return `workflow: ${step.goal}`;
    case 'signIn':
      return `signIn as ${step.as}`;
    case 'expectUrl':
      return `expectUrl ${step.value}`;
    default: {
      const s = step as { action: string; selector?: string; value?: string };
      return `${s.action}${s.selector === undefined ? '' : ` ${s.selector}`}${s.value === undefined ? '' : ` = ${JSON.stringify(s.value)}`}`;
    }
  }
}

/**
 * Every leg's pairs parse back out of its goal — the round-trip the engine
 * depends on. A pair is read when an outcome carries its value under a
 * control whose words are all in the pair's key: the engine's `cleanControl`
 * strips the sheet's leading verb (`คีย์ Employee Group` → `Employee Group`),
 * and that is the control it will look for on the page.
 */
export function legsRoundTrip(plan: CatalogPlan): { leg: CatalogLeg; missing: TestDataPair[] }[] {
  const out: { leg: CatalogLeg; missing: TestDataPair[] }[] = [];
  for (const leg of plan.legs) {
    const parsed = goalOutcomes(leg.goal);
    const missing = leg.pairs.filter((pair) => {
      const keyWords = words(pair.key);
      return !parsed.some((o) => o.value === pair.value && words(o.control).every((w) => keyWords.includes(w)));
    });
    if (missing.length > 0) out.push({ leg, missing });
  }
  return out;
}
