/**
 * The facts every renderer shows about a step — one reading of the record
 * for the HTML report, the catalog report, the Excel export, the machine
 * report and wowUI (which mirrors these in its own script, function by
 * function, the way it already mirrors `describeValueSource`).
 *
 * Why this exists (enhancedX wave 2, 2026-09-03): the harness grew four step
 * kinds the renderers had never met — `expectAnyVisible` (a list of
 * selectors, no `selector`), `expectFieldError` (a field and the message under
 * it), `upload` (files) and `signIn` (a persona) — and two resolutions
 * (`reveal`, `scroll`). Every renderer read `step.selector` and printed
 * `step.resolution` raw, so an either/or assertion (PY "ระบบประมวลผลสำเร็จหรือ
 * แสดง error ตามเงื่อนไข", 95 rows) rendered as an EMPTY row and a step that
 * only worked because a collapsed section was opened wore a badge that said
 * `reveal` and nothing else. A step kind that renders as an empty row is the
 * failure mode this module is here to make impossible: the target and the
 * facts are computed HERE, from the record, and every renderer asks.
 *
 * Two rules, both load-bearing:
 *
 * - **Never a credential.** A `signIn` step is rendered by its persona LABEL
 *   (`HR_ADMIN_ACCOUNT`) and nothing else. The engine may record the resolved
 *   email on the step; `visibleDetail` drops every credential-shaped key from
 *   the generic detail dump, and a label that IS an email is withheld. The
 *   report travels — by mail, on a USB stick, into a bug tracker.
 * - **Never file contents.** An `upload` shows file NAMES: what was attached
 *   is evidence, what was in it is not the report's to carry (a fixture PDF
 *   is bytes; a CSV may hold the data under test).
 *
 * Everything here is pure and defensive: the engine half of every new kind
 * is being wired in the same wave, so each reader accepts the shape the
 * contract names AND the nearest plausible one, and returns nothing rather
 * than a placeholder that reads like a fact.
 */

import { isPassing } from '../engine/proof-bundle.js';
import { DB_EVIDENCE_MAX_ROWS } from '../db/redact-row.js';
import type { AgentAction, ProofBundle, ResolutionSource } from '../engine/proof-bundle.js';

/** One labelled fact about a step, rendered wherever the step is. */
export interface StepFact {
  label: string;
  value: string;
}

/** The slice of a step every reader here needs. Structural, so wowUI's cards and half-built records fit. */
export interface StepLike {
  action: string;
  selector?: string | null | undefined;
  resolvedSelector?: string | null | undefined;
  detail?: Record<string, unknown> | undefined;
  /** Who the step ran as and on which Chrome — see `ProofStep.persona` / `.browser`. */
  persona?: string | undefined;
  browser?: string | undefined;
  /** The agent record, when the step was a workflow leg; `observations` (OA-14) is read off it structurally. */
  agent?: object | undefined;
  /** A model's plain-language reading of the step — see `stepNarration`. */
  narration?: unknown;
}

/**
 * The slice `stepNarration` needs. Structural and `unknown`-typed on purpose:
 * the field is optional on the bundle and absent from every run that did not
 * ask for it, so a reader must handle "not there" and "not the shape" the
 * same way — by rendering nothing.
 */
export interface NarratedLike {
  narration?: unknown;
}

/** A persona LABEL and nothing else: no address, no `LABEL=email:password` remnant. See `signInPersona`. */
const LABEL_ONLY = /^[^@:]+$/;
/** An address anywhere in a string — the rule for a `signIn` step's detail, where any string may carry the account. */
const CONTAINS_EMAIL = /[^\s@"']+@[^\s@"']+\.[^\s@"']+/;

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value !== '' ? [value] : [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry !== '') out.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const named = entry as { name?: unknown; path?: unknown; selector?: unknown };
      const name =
        typeof named.name === 'string' ? named.name : typeof named.path === 'string' ? named.path : typeof named.selector === 'string' ? named.selector : null;
      if (name !== null && name !== '') out.push(name);
    }
  }
  return out;
}

/** The last path segment — a file NAME, never where it sat on the author's disk. */
function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The selectors an `expectAnyVisible` offered. The contract records them
 * under `detail.selectors`; a runner that joined them into `selector` with
 * ` | ` (the CLI's own spelling of an alternative) is read too.
 */
export function anyVisibleSelectors(step: StepLike): string[] {
  const listed = stringsOf(step.detail?.['selectors']);
  if (listed.length > 0) return listed;
  const joined = step.selector ?? '';
  return joined.includes(' | ') ? joined.split(' | ').map((s) => s.trim()).filter((s) => s !== '') : joined === '' ? [] : [joined];
}

/** The file names an `upload` attached. Names only — see the module note. */
export function uploadedFileNames(step: StepLike): string[] {
  const detail = step.detail ?? {};
  const listed = stringsOf(detail['files']);
  const named = listed.length > 0 ? listed : stringsOf(detail['fileNames'] ?? detail['file']);
  return named.map(fileName);
}

/**
 * The persona a `signIn` step signed in as — its LABEL, and only ever a label.
 *
 * A label is what the flow is supposed to carry (`<MANAGER_ACCOUNT>`, `HR
 * admin`). Anything holding an `@` or a `:` is not one: an address is a
 * credential's other half, and a colon is the persona wire format's own
 * separator (`LABEL=email:password`), so everything after it is a password.
 * Both are withheld.
 *
 * The previous rule tested for a well-formed address, which let two shapes
 * through that a person actually produces: a value with no dot in the domain
 * (`mgr@intranet:pw`) and a label with a password appended (`HRBP_ACCOUNT:pw`).
 * Structure decides this, not well-formedness — the cost of withholding a
 * legitimate label is one generic phrase in the report, and the cost of
 * printing is a password.
 */
export function signInPersona(step: StepLike): string | null {
  const detail = step.detail ?? {};
  const raw = detail['as'] ?? detail['persona'] ?? detail['personaLabel'];
  if (typeof raw !== 'string' || raw === '') return null;
  return LABEL_ONLY.test(raw) ? raw : 'an account named by its credentials (withheld from the report)';
}

/** The author's own timeout on a step, when they set one (`timeoutMs` on the FlowStep, recorded on the detail). */
export function authoredTimeout(step: StepLike): string | null {
  const raw = step.detail?.['timeoutMs'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw >= 1000 ? `${(raw / 1000).toFixed(raw % 1000 === 0 ? 0 : 1)}s` : `${Math.round(raw)}ms`;
}

/**
 * What the step was aimed at, for the one line every renderer prints beside
 * the action. The resolved selector, else the authored one, else — for the
 * kinds that have no single selector — a description built from the record.
 * Null only when the record truly names nothing (a `goto`, an HTTP step).
 */
export function stepTarget(step: StepLike): string | null {
  const selector = step.resolvedSelector ?? step.selector ?? null;
  if (selector !== null && selector !== '') return selector;
  switch (step.action) {
    case 'expectAnyVisible': {
      const selectors = anyVisibleSelectors(step);
      return selectors.length === 0 ? null : selectors.join(' | ');
    }
    case 'signIn': {
      const persona = signInPersona(step);
      return persona === null ? null : `persona ${persona}`;
    }
    case 'upload': {
      const files = uploadedFileNames(step);
      return files.length === 0 ? null : files.join(', ');
    }
    default:
      return null;
  }
}

/**
 * The labelled facts a step kind carries beyond its selector, in the order
 * a reader checks them. Empty for the ordinary kinds — the selector line and
 * `expectedActual` already say everything about a `click` or an `expectText`.
 */
export function stepKindFacts(step: StepLike): StepFact[] {
  const facts: StepFact[] = [];
  const detail = step.detail ?? {};
  switch (step.action) {
    case 'expectAnyVisible': {
      const selectors = anyVisibleSelectors(step);
      if (selectors.length > 0) facts.push({ label: 'any of', value: selectors.map((s, i) => `${i + 1}. ${s}`).join('\n') });
      const matched = detail['matched'] ?? detail['visible'] ?? detail['satisfiedBy'];
      if (typeof matched === 'string' && matched !== '') facts.push({ label: 'satisfied by', value: matched });
      break;
    }
    case 'expectFieldError': {
      const field = step.selector ?? null;
      if (field !== null && field !== '') facts.push({ label: 'field', value: field });
      const via = detail['via'] ?? detail['readVia'];
      if (typeof via === 'string' && via !== '') facts.push({ label: 'message read via', value: via });
      break;
    }
    case 'upload': {
      const files = uploadedFileNames(step);
      if (files.length > 0) facts.push({ label: files.length === 1 ? 'file' : 'files', value: files.join(', ') });
      const via = detail['via'] ?? detail['attachedVia'];
      if (typeof via === 'string' && via !== '') facts.push({ label: 'attached via', value: via });
      break;
    }
    case 'signIn': {
      const persona = signInPersona(step);
      if (persona !== null) facts.push({ label: 'persona', value: persona });
      // One Chrome per persona: a switch back to a person already signed
      // in keeps their session; a new person got a browser of their own.
      if (detail['keptSession'] === true) facts.push({ label: 'session', value: 'kept — switched to this persona\'s own browser, no login' });
      else if (detail['inheritedSession'] === true) facts.push({ label: 'session', value: 'inherited from the suite, no login' });
      else if (typeof detail['openedBrowser'] === 'string') facts.push({ label: 'session', value: 'new — on a browser of its own' });
      break;
    }
    default:
      break;
  }
  const browser = browserFact(step);
  if (browser !== null) facts.push({ label: 'browser', value: browser });
  const timeout = authoredTimeout(step);
  if (timeout !== null) facts.push({ label: 'timeout', value: `${timeout} (set by the author)` });
  return facts;
}

/**
 * Which Chrome a step ran on, as its port (`9223`), when the run spread
 * personas over more than one — the step's own stamp, else the `signIn`
 * detail that opened or switched to it. Null on a single-browser run,
 * where "browser 9222" on every line would be noise.
 */
export function browserFact(step: StepLike): string | null {
  const detail = step.detail ?? {};
  const raw = step.browser ?? detail['browser'] ?? detail['switchedTo'] ?? detail['openedBrowser'];
  if (typeof raw !== 'string' || raw === '') return null;
  const port = raw.match(/:(\d+)\/?$/)?.[1];
  const who = step.persona !== undefined && step.persona !== '' ? ` (${step.persona})` : '';
  return `${port ?? raw}${who}`;
}

/* --------------------------------------------------------- the narration */

/**
 * The label every surface puts in front of a narration, and the note that
 * says what it is. One wording, three surfaces — a sentence a reader meets
 * differently framed in the report, the catalog and the workbook is a
 * sentence they will weigh differently.
 */
export const NARRATION_LABEL = 'in plain language';
/**
 * Short on purpose: it is rendered as a `title` on EVERY narrated step, and a
 * 400-case catalog narrating twenty steps each repeats it eight thousand
 * times. Two facts earn their bytes — where the sentence came from, and that
 * it decides nothing.
 */
export const NARRATION_NOTE =
  "A model's plain-language reading of this step's own recorded line, written after the run from that line and nothing else. Descriptive only: it sets no status, files no defect, and is no part of the verdict.";

/** A narration as it reaches a renderer — see `ProofStep.narration`. */
export interface StepNarrationLine {
  /** The sentences, whitespace-folded, verbatim otherwise. Application text inside them is quoted, never translated. */
  text: string;
  /** The model that wrote them, as the surfaces credit it. */
  by: string;
  label: string;
  /** The visible attribution: short enough to sit on every step. */
  attribution: string;
  note: string;
}

/**
 * The step's narration, or null when it has none — which is every step of
 * every run that did not ask for one (`--narrate`), so "null renders exactly
 * what the step rendered before this existed" is the common case, not the
 * edge one.
 *
 * Defensive like the rest of this module: a bundle written by an older build,
 * or one whose narration is an empty string, has no narration at all. Never a
 * placeholder that reads like a fact.
 */
export function stepNarration(step: NarratedLike): StepNarrationLine | null {
  const record = step.narration;
  if (record === null || record === undefined || typeof record !== 'object') return null;
  const raw = (record as { text?: unknown }).text;
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return null;
  const attributed = (record as { by?: unknown }).by;
  // Never unattributed: a sentence with no author reads as the harness's own.
  const by = typeof attributed === 'string' && attributed.trim() !== '' ? attributed.trim() : 'a model';
  return { text, by, label: NARRATION_LABEL, attribution: `written by ${by}`, note: NARRATION_NOTE };
}

/**
 * The narration as one line of plain text — what a workbook cell and any
 * other unstyled surface carries, where a muted colour and a hover cannot do
 * the marking. The label and the attribution are inside the line itself.
 */
export function narrationProofLine(step: NarratedLike): string | null {
  const narration = stepNarration(step);
  return narration === null
    ? null
    : `${narration.label} (${narration.attribution}; a description of this step, not a recorded fact): ${narration.text}`;
}

/**
 * Detail keys that can carry a credential or its other half. Dropped from
 * every generic detail dump, on every step kind — an `email` on a `fill` is
 * the sheet's own test data, but an `email` beside a `password` key is a
 * login, and the dump cannot tell which; the facts above say what matters.
 */
export const CREDENTIAL_DETAIL_KEYS = /password|passwd|pwd|secret|token|credential|signedIn|personas|^email$|^as$/i;

/**
 * Keys a renderer has already shown as a dedicated line — the intent, the
 * comparison, the kind facts, the observations — so the generic dump does
 * not repeat them verbatim underneath.
 */
const DEDICATED_DETAIL_KEYS = new Set([
  'intent',
  'expected',
  'actual',
  'selectors',
  'files',
  'fileNames',
  'file',
  'persona',
  'personaLabel',
  'timeoutMs',
  'observed',
  'valueSource',
]);

/**
 * The generic key/value entries a renderer may dump for a step: everything
 * the dedicated lines did not already show, minus anything credential-shaped
 * (see `CREDENTIAL_DETAIL_KEYS`), and on a `signIn` step minus any string
 * that carries an email whatever its key.
 */
export function visibleDetail(step: StepLike): [string, unknown][] {
  const detail = step.detail;
  if (!detail) return [];
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'intent' && typeof value === 'string') continue;
    if (DEDICATED_DETAIL_KEYS.has(key) && key !== 'intent') continue;
    if (CREDENTIAL_DETAIL_KEYS.test(key)) continue;
    if (step.action === 'signIn' && typeof value === 'string' && CONTAINS_EMAIL.test(value)) continue;
    out.push([key, value]);
  }
  return out;
}

/**
 * Plain-language name and explanation for every way a selector resolves.
 * `fast` has no label — every ordinary step resolves that way and badging
 * it would mark exactly the steps that need no attention. The explanation
 * is what the report's `<abbr>` shows and what the Excel Proof column and
 * wowUI's "rung" line append, so a reader meeting `reveal` for the first
 * time is told what was done on their behalf.
 */
export const RESOLUTION_EXPLANATIONS: Record<Exclude<ResolutionSource, 'fast'>, { label: string; explanation: string }> = {
  case: {
    label: 'matched ignoring letter-case',
    explanation:
      'The selector matched once letter-case was ignored. Chrome and Playwright compute accessible names differently when CSS changes text case.',
  },
  narrow: {
    label: 're-matched against the page text',
    explanation:
      "A text selector that did not match as written, re-matched for free against what the page actually contains: an unquoted substring form narrowed to exact text when it hit several elements, or a quoted exact form relaxed to a substring when the page renders the value with formatting around it. The asserted text is on the page; the selector was written tighter or broader than the rendering.",
  },
  reveal: {
    label: 'a collapsed section was opened first',
    explanation:
      "The author's selector matched a control folded inside a collapsed section (an accordion, a <details>, a tab), so its disclosure was clicked and the SAME selector run again. Free and deterministic — no model, no rewrite of the selector. The step passed on its own terms; the flow could add the click that opens the section.",
  },
  scroll: {
    label: 'scrolled clear of a fixed bar',
    explanation:
      "The author's selector resolved, but a fixed or sticky bar was covering it and intercepted the pointer, so the control was scrolled to the middle of the viewport and the same selector acted. Free and deterministic; nothing about the selector changed.",
  },
  kin: {
    label: 'held against the control\'s container',
    explanation:
      "The author's selector resolved, only its TEXT missed, and the claim held against the element's container instead — a label whose value sits beside it rather than inside it. Free and deterministic.",
  },
  'agent-read': {
    label: 'the agent pointed, the harness checked',
    explanation:
      "The agent was asked the assertion's own question — read-only, it could not act — and named the element holding the answer; the harness then re-ran the author's comparison against it. The agent's answer is checked, never believed.",
  },
  late: {
    label: 'resolved late',
    explanation:
      'The content appeared, but only when given the longer healed-selector window — slower than the fast-path budget. The feature works; the page is slow or hydrates late, and a timing defect records it.',
  },
  cache: { label: 'reused an earlier repair', explanation: 'A selector repaired on a previous run was reused here, at no cost.' },
  jit: {
    label: 'selector auto-repaired',
    explanation:
      'The selector in the test did not match; a model proposed a replacement, which was verified to match exactly one element before being used. Worth updating the test.',
  },
  dialog: {
    label: 'dialog dismissed first',
    explanation: 'Something was covering the page — a cookie banner, a modal — so it was dismissed and the original selector retried.',
  },
  agent: {
    label: 'agent cleared the way',
    explanation:
      'The control was not reachable — behind a closed menu, below the fold, or on a view still loading — so an agent drove the browser until it was, and then the step ran the original selector. The test passed on its own terms; it just could not get there unaided. Add the steps that reveal the control.',
  },
};

/**
 * Label + explanation for a resolution, or null for `fast` and for nothing.
 * A resolution this module has never heard of comes back under its own name
 * with a one-line note — a rung added later must never silently vanish from
 * the account of how a step resolved.
 */
export function describeResolution(resolution: string | null | undefined): { label: string; explanation: string } | null {
  if (!resolution || resolution === 'fast') return null;
  const known = (RESOLUTION_EXPLANATIONS as Record<string, { label: string; explanation: string }>)[resolution];
  return known ?? { label: resolution, explanation: `The selector resolved through the "${resolution}" rung of the escalation ladder.` };
}

/** One observation the workflow agent read off the live page, carried as evidence. */
export interface ObservedItem {
  selector: string | null;
  text: string;
  url: string | null;
}

function observedItemOf(raw: unknown): ObservedItem | null {
  if (typeof raw === 'string') return raw === '' ? null : { selector: null, text: raw, url: null };
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as { selector?: unknown; text?: unknown; url?: unknown; value?: unknown };
  const text = typeof item.text === 'string' ? item.text : typeof item.value === 'string' ? item.value : '';
  if (text === '') return null;
  return {
    selector: typeof item.selector === 'string' && item.selector !== '' ? item.selector : null,
    text,
    url: typeof item.url === 'string' && item.url !== '' ? item.url : null,
  };
}

/**
 * What a `workflow` step's agent OBSERVED (its `read` actions), from
 * `detail.observed` — the contract — or, failing that, the record's own
 * `observations`. The observe-and-record legs ("บันทึกค่าที่ระบบแสดงจริง",
 * ~250 lines across EC/PRB/TM) end with these as their only evidence, and a
 * report that lost them under one 120-character history line had nothing to
 * show for the leg.
 */
export function observedEvidence(step: StepLike): ObservedItem[] {
  const fromDetail = step.detail?.['observed'];
  const fromAgent = (step.agent as { observations?: unknown } | undefined)?.observations;
  const raw: unknown[] = Array.isArray(fromDetail) ? fromDetail : Array.isArray(fromAgent) ? fromAgent : [];
  const out: ObservedItem[] = [];
  for (const entry of raw) {
    const item = observedItemOf(entry);
    if (item !== null) out.push(item);
  }
  return out;
}

/** The slice of an agent action every renderer reads. `observed` is OA-14's optional field. */
export type AgentActionLike = Pick<AgentAction, 'action' | 'selector' | 'value' | 'url'> & { observed?: unknown };

const PASSWORD_SELECTOR = /password|passwd|pwd/i;

/**
 * How one agent turn is shown: what it was aimed at, and a note when the
 * action's meaning is not in its target. Knows the two actions the agent
 * gained in this wave — `save` (a page value into the run's variables for
 * later steps, OA-8) and `signOut` (end the session so the next person can
 * sign in, OA-15) — and treats every other name by the old rule, so an
 * action added later still renders with its selector rather than as `—`.
 * A password-shaped fill shows the value's length, never its characters.
 */
export function describeAgentAction(action: AgentActionLike): { target: string; note: string | null } {
  const selector = action.selector ?? '';
  const value = action.value ?? '';
  const observed = typeof action.observed === 'string' && action.observed !== '' ? action.observed : null;
  switch (action.action) {
    case 'save':
      return {
        target: selector === '' ? (value === '' ? '—' : `{{${value}}}`) : value === '' ? selector : `${selector} → {{${value}}}`,
        note: observed === null ? 'saved a value the page shows for later steps' : `saved ${JSON.stringify(observed)} for later steps`,
      };
    case 'signOut':
      return { target: 'the current session', note: 'signed out so another person can sign in' };
    case 'read':
      return { target: selector === '' ? action.url : selector, note: observed === null ? null : `observed ${JSON.stringify(observed)}` };
    case 'fill':
    case 'type':
    case 'paste':
      return {
        target: selector === '' ? action.url : selector,
        note:
          value === ''
            ? null
            : PASSWORD_SELECTOR.test(selector)
              ? `•••• (${value.length} chars)`
              : `= ${JSON.stringify(value)}`,
      };
    default:
      return {
        target: selector !== '' ? selector : action.url !== '' ? action.url : value !== '' ? value : '—',
        note: observed === null ? null : `observed ${JSON.stringify(observed)}`,
      };
  }
}

/**
 * An agent leg that did not determine its step's outcome.
 *
 * Measured over this workspace's 722 sealed bundles (10,247 steps, 988 agent
 * legs, 2026-09-08): 112 legs in 70 bundles. Two shapes, both of them a leg
 * a reader scrolls past on the way to the steps that decided something:
 *
 * - **`looked-only`** (85) — `AgentRecord.lookedOnly`: the loop never engaged
 *   a control the goal names. The runner already treats this as a reading
 *   question deferred to the assertions after it (`verification-deferred`).
 *   The wording here is deliberately NOT the field's doc comment ("every
 *   action was a scroll or a wait"): `WorkflowAgent` sets the flag on TWO
 *   branches — `onlyLooked` (every action idle) and `missedEveryInteraction`
 *   (it clicked, and no click ever engaged anything) — and on this
 *   workspace's bundles the second is 76 of the 85. "Every action was a
 *   scroll or a wait" would be a false sentence about 76 real steps, so the
 *   one clause both branches make true is the one that is printed.
 * - **`did-not-decide`** (27) — the agent reported `success: false` and the
 *   step passed anyway, on the flow's own selector. This is the assist rung
 *   stalling on its second turn after its first action had already opened
 *   the panel; `agentBlock` was re-worded for exactly this shape in 2026-09-04
 *   ("A rescued step shows once"), and folding is the same fact carried one
 *   step further.
 *
 * Four shapes are deliberately NOT inconsequential, and every surface must
 * keep rendering them exactly as it does today:
 *
 * - **a leg on a step that did not pass** — that leg IS the evidence of the
 *   failure, and failure evidence is never folded. This is why BOTH shapes
 *   require a passing step, including `lookedOnly`: a look-only leg on a
 *   broken step is the whole account of what was tried.
 * - **a held action** (`ProofStep.blocked`, `AgentRecord.blocked`) — the
 *   harness withheld a mutation; that is never noise.
 * - **`endedBy: 'fail'`** — the model's own claim that it could not proceed.
 *   7 of the 119 candidate legs above; they stay open.
 * - a leg whose actions changed the page and the step then passed — it DID
 *   decide the outcome, and it has neither marker.
 *
 * Pure and structural, like the rest of this module: the fields are optional
 * and absent from bundles older than them, and an unrecognised shape folds
 * nothing. This decides only how a leg is LAID OUT; nothing here is a status,
 * a verdict, a defect or a count, and no surface may remove the leg from the
 * document — it is folded behind a closed disclosure, still a full record,
 * the same rule a superseded attempt follows.
 */
export type InconsequentialAgentLegKind = 'looked-only' | 'did-not-decide';

/** The slice `inconsequentialAgentLeg` reads. `unknown`-typed so a half-built record fits. */
export interface AgentLegLike {
  status?: string | undefined;
  /** `ProofStep.blocked` — the harness withheld the action. */
  blocked?: unknown;
  agent?: unknown;
}

export interface InconsequentialAgentLeg {
  kind: InconsequentialAgentLegKind;
  /** Why it did not decide the outcome, in one clause — the honest half of the summary. */
  why: string;
  /** The one line every surface folds the leg behind. */
  summary: string;
}

/**
 * The one wording, three surfaces. A leg framed one way in the report and
 * another in the workbook is a leg a reader weighs differently.
 */
export const AGENT_LEG_ASIDE_LABEL = "agent leg — did not affect this step's outcome";

const AGENT_LEG_ASIDE_WHY: Record<InconsequentialAgentLegKind, string> = {
  'looked-only': 'it never engaged a control the goal names',
  'did-not-decide': "the step passed on the flow's own selector regardless",
};

/**
 * `null` for every leg that decided something, which is every leg on a run
 * that has no such shape — so "null renders exactly what the step rendered
 * before this existed" is the common case, not the edge one.
 */
export function inconsequentialAgentLeg(step: AgentLegLike): InconsequentialAgentLeg | null {
  const agent = step.agent;
  if (agent === null || agent === undefined || typeof agent !== 'object') return null;
  // A hold is not noise: the harness withheld an action, and the step says so.
  if (step.blocked !== null && step.blocked !== undefined) return null;
  const record = agent as { success?: unknown; lookedOnly?: unknown; blocked?: unknown; endedBy?: unknown };
  if (record.blocked !== null && record.blocked !== undefined) return null;
  // The model's own claim that it could not proceed stays where a reader meets it.
  if (record.endedBy === 'fail') return null;
  // `isPassing` is the one rule every surface follows; a step is never
  // `passed-with-issues`, so this is exactly "the step passed".
  if (typeof step.status !== 'string' || !isPassing(step.status)) return null;
  const kind: InconsequentialAgentLegKind | null =
    record.lookedOnly === true ? 'looked-only' : record.success === false ? 'did-not-decide' : null;
  if (kind === null) return null;
  const why = AGENT_LEG_ASIDE_WHY[kind];
  return { kind, why, summary: `${AGENT_LEG_ASIDE_LABEL}: ${why}` };
}

/* ------------------------------------------------------- database checks */

/**
 * The database check a step made, projected once for all three surfaces.
 *
 * Everything here was redacted on its way into the bundle (`redact-row.ts`),
 * and this function must never reach past `step.db` for a raw value — the
 * same rule the per-run report's `requestBlock`/`dbBlock` have always
 * followed: a report that re-derives a value is the leak.
 *
 * It reads defensively. A bundle sealed before the statement was recorded
 * has no `statements` and no `rowsMatched`, and renders exactly the summary
 * it always did: no query section, and never an invented one. A check that
 * was refused before any SQL ran (an undeclared table, an unparseable where,
 * no connection) is exactly that case.
 */
export interface DbEvidenceStatement {
  sql: string;
  /** Bound values in `$1…$n` order, redacted at the source. */
  params: string[];
  tables: string[];
}

export interface DbEvidence {
  kind: string;
  /** The table(s) the check was about, however the record spells them. */
  target: string | null;
  where: string | null;
  expected: string | null;
  observed: string | null;
  note: string | null;
  durationMs: number | null;
  polledMs: number | null;
  /** The statement(s) the check ran. Empty for a bundle sealed before they were recorded. */
  statements: DbEvidenceStatement[];
  /** Header row of the sample: every column any sampled row names, in first-appearance order. */
  columns: string[];
  /** One row per sampled row, aligned to `columns`; a column a row does not hold is empty. */
  rows: string[][];
  rowsMatched: number | null;
  /** `showing 3 of 42 row(s) — the sample is capped at 3`, or null when nothing is shown. */
  sample: string | null;
}

/** The slice `dbEvidence` reads. `unknown` so a half-built record fits. */
export interface DbCheckLike {
  db?: unknown;
}

/** One wording, three surfaces — a query labelled `query` here and `SQL` there is two things to a reader. */
export const DB_QUERY_LABEL = 'query';
export const DB_PARAMS_LABEL = 'parameters';
export const DB_ROWS_LABEL = 'rows returned';

function dbStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function dbNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function dbEvidence(step: DbCheckLike): DbEvidence | null {
  const record = step.db;
  if (record === null || record === undefined || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  const kind = dbStr(r['kind']) ?? 'check';

  const tables = Array.isArray(r['tables'])
    ? (r['tables'] as unknown[]).filter((t): t is string => typeof t === 'string' && t !== '')
    : [];
  const target = dbStr(r['table']) ?? (tables.length > 0 ? tables.join(', ') : null);

  const statements: DbEvidenceStatement[] = [];
  if (Array.isArray(r['statements'])) {
    for (const entry of r['statements'] as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const sql = dbStr(e['sql']);
      if (sql === null) continue;
      statements.push({
        sql,
        params: Array.isArray(e['params'])
          ? (e['params'] as unknown[]).map((p) => (typeof p === 'string' ? p : String(p)))
          : [],
        tables: Array.isArray(e['tables'])
          ? (e['tables'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
      });
    }
  }

  // The sample as a real table: the columns are the union of what the rows
  // name, in the order they first appear, so a row missing a column renders
  // an empty cell rather than shifting every value one place left.
  const columns: string[] = [];
  const rows: string[][] = [];
  const sampled = Array.isArray(r['rows']) ? (r['rows'] as unknown[]) : [];
  for (const row of sampled) {
    if (row === null || typeof row !== 'object') continue;
    for (const column of Object.keys(row as Record<string, unknown>)) {
      if (!columns.includes(column)) columns.push(column);
    }
  }
  for (const row of sampled) {
    if (row === null || typeof row !== 'object') continue;
    const cells = row as Record<string, unknown>;
    rows.push(columns.map((column) => (column in cells ? String(cells[column] ?? '') : '')));
  }

  const rowsMatched = dbNum(r['rowsMatched']);
  // `called` samples matching STATEMENTS, not rows of a table; the caption
  // must say what it is showing or it reads as a result set.
  const subject = kind === 'called' ? 'matching statement(s)' : 'row(s)';
  const sample =
    rows.length === 0
      ? null
      : rowsMatched !== null && rowsMatched > rows.length
        ? `showing ${rows.length} of ${rowsMatched} ${subject} — the sample is capped at ${DB_EVIDENCE_MAX_ROWS}`
        : `${rows.length} ${subject}`;

  return {
    kind,
    target,
    where: dbStr(r['where']),
    expected: dbStr(r['expected']),
    observed: dbStr(r['observed']),
    note: dbStr(r['note']),
    durationMs: dbNum(r['durationMs']),
    polledMs: dbNum(r['polledMs']),
    statements,
    columns,
    rows,
    rowsMatched,
    sample,
  };
}

/**
 * The same evidence for a surface with no table and no disclosure — the
 * workbook's Proof cell. One fact per line, in the order a reader checks
 * them: what the check claimed, then the SQL that answered it, then the rows
 * it got back.
 */
export function dbProofLines(step: DbCheckLike): string[] {
  const e = dbEvidence(step);
  if (e === null) return [];
  const lines: string[] = [];
  lines.push(`db ${e.kind}${e.target === null ? '' : ` on ${e.target}`}`);
  if (e.where !== null) lines.push(`where ${e.where}`);
  if (e.expected !== null) lines.push(`expected ${e.expected}`);
  if (e.observed !== null) lines.push(`observed ${e.observed}`);
  for (const statement of e.statements) {
    lines.push(`${DB_QUERY_LABEL}: ${statement.sql}`);
    if (statement.params.length > 0) {
      lines.push(
        `${DB_PARAMS_LABEL}: ${statement.params.map((p, i) => `$${i + 1} = ${p}`).join(' · ')}`,
      );
    }
  }
  if (e.rows.length > 0) {
    lines.push(e.sample === null ? DB_ROWS_LABEL : `${DB_ROWS_LABEL} — ${e.sample}`);
    lines.push(e.columns.join(' | '));
    for (const row of e.rows) lines.push(row.join(' | '));
  }
  if (e.polledMs !== null) lines.push(`polled ${e.polledMs}ms`);
  if (e.note !== null) lines.push(`note: ${e.note}`);
  return lines;
}

/* --------------------------------------------------- a step that decided nothing */

/**
 * The actions whose outcome IS a claim.
 *
 * Mirrors `ASSERTION_ACTIONS` in the runner, restated here for exactly the
 * reason `proof-bundle.ts` restates it: this plane cannot import the runner
 * (the whole execution plane, Playwright included, would come with it), and
 * the reporter is a pure render over a bundle. `tests/reporter-wave2.test.ts`
 * pins the mirror against the runner's own list, so it cannot drift quietly.
 */
export function isAssertionStepAction(action: string | null | undefined): boolean {
  return (
    typeof action === 'string' &&
    (action.startsWith('expect') ||
      action === 'snapshot' ||
      action === 'fillEach' ||
      action === 'fillRetry')
  );
}

/** The slice `inconsequentialBrokenStep` reads of a step. */
export interface BrokenStepLike {
  index?: number | undefined;
  action?: string | undefined;
  status?: string | undefined;
  /** `ProofStep.superseded` — an attempt a reconstruction replaced; already folded as one. */
  superseded?: unknown;
  /** `ProofStep.blocked` — the harness withheld the action. */
  blocked?: unknown;
}

/** The run a broken step is judged against — the bundle's own status and step list. */
export interface BrokenStepRunLike {
  status?: string | undefined;
  steps?: readonly BrokenStepLike[] | undefined;
}

export interface InconsequentialStep {
  /** The status as SEALED — never rewritten, only laid out differently. */
  status: string;
  /** Why it did not decide the outcome, in one clause. */
  why: string;
  /** The one line every surface folds the step behind. */
  summary: string;
}

/**
 * The one wording, three surfaces. Built from constants and the sealed
 * status only: no application text, no selector, no credential can reach it.
 */
export const BROKEN_STEP_ASIDE_LABEL = "did not decide this run's outcome";

const BROKEN_STEP_ASIDE_WHY =
  'it makes no claim, the run carried past it, and every claim the run did make held';

/** The run outcomes that mean the claims held. `pass**` IS a pass. */
const RUN_PASSED = new Set(['passed', 'passed-with-issues']);

/**
 * A broken step that decided nothing — folded, never dropped.
 *
 * `passed-with-issues` is the engine's own name for this run: the claims
 * held, the path did not. Inside such a run an *action* step that broke sits
 * red beside real failures, and a reader who learns that red does not mean a
 * finding stops reading red at all. So it is laid out as an aside — and
 * `inconsequentialAgentLeg`'s constitution applies word for word: this
 * decides only how a step is LAID OUT. It is not a status, not a verdict,
 * not a defect, not a count. It changes no run status, no case verdict, no
 * tally, no defect table, not `harnessOnly()` and no exit code, and no
 * surface may remove the step from the document — it goes behind a CLOSED
 * disclosure whose summary names the sealed status and why it did not
 * decide, and a reader who opens it sees exactly what they see today.
 *
 * Every condition is structural, over typed fields, and all must hold:
 *
 * - **it claims nothing** — the action is not an assertion
 *   (`isAssertionStepAction`), so it has no expected-result verdict to fail;
 * - **it broke, and the harness did not** — status `failed` or `dead-end`,
 *   NEVER `error` (an `error` says the harness could not proceed, and
 *   `harnessOnly()` in `cli/exit.ts` depends on it being visible) and never a
 *   step carrying `blocked` (a withheld action is a finding about the run);
 * - **the run reached a passing outcome anyway** — its status is `passed` or
 *   `passed-with-issues`, it made at least one assertion, and every
 *   assertion step passed;
 * - **nothing downstream depended on it** — the run carried past it: at
 *   least one later step ran and passed, and no later step was skipped or
 *   ended in `error`. A later *action* step that also broke does not make
 *   this one consequential; a later step the run never reached does.
 *
 * A superseded attempt returns null: it is already folded under the step
 * that replaced it (`details.replaced`), and folding it twice would hide the
 * rescue as well as the attempt.
 */
export function inconsequentialBrokenStep(
  step: BrokenStepLike,
  run: BrokenStepRunLike,
): InconsequentialStep | null {
  if (typeof run.status !== 'string' || !RUN_PASSED.has(run.status)) return null;
  if (step.superseded === true) return null;
  if (step.blocked !== null && step.blocked !== undefined) return null;
  if (isAssertionStepAction(step.action)) return null;
  if (typeof step.action !== 'string' || step.action === '') return null;
  const status = step.status;
  if (status !== 'failed' && status !== 'dead-end') return null;

  const steps = (run.steps ?? []).filter((s) => s.superseded !== true);
  // A run that proved nothing has nothing to say this break was beside the
  // point OF; and one unheld claim makes every break part of the account.
  let assertions = 0;
  for (const s of steps) {
    if (!isAssertionStepAction(s.action)) continue;
    assertions += 1;
    if (typeof s.status !== 'string' || !isPassing(s.status)) return null;
  }
  if (assertions === 0) return null;

  let position = steps.indexOf(step);
  if (position === -1 && typeof step.index === 'number') {
    position = steps.findIndex((s) => s.index === step.index);
  }
  // A step this run's own list does not hold cannot be placed in it, and a
  // fold decided without the downstream evidence would be a guess.
  if (position === -1) return null;

  const after = steps.slice(position + 1);
  let carriedOn = false;
  for (const s of after) {
    if (typeof s.status === 'string' && isPassing(s.status)) {
      carriedOn = true;
      continue;
    }
    // Another action step that broke leaves the run's claims exactly where
    // they were. A step that never ran, or one the harness ended, does not.
    if ((s.status === 'failed' || s.status === 'dead-end') && !isAssertionStepAction(s.action)) {
      continue;
    }
    return null;
  }
  if (!carriedOn) return null;

  return {
    status,
    why: BROKEN_STEP_ASIDE_WHY,
    summary: `${status} — ${BROKEN_STEP_ASIDE_LABEL}: ${BROKEN_STEP_ASIDE_WHY}`,
  };
}

/* --------------------------------------------------------------- cases */

/**
 * The sheet-side facts a bundle's provenance may carry once the catalog
 * plane stamps them (CG-04's `sheetCaseId`, the workbook's `sheet` and
 * `category`, CG-09's `recordOnly`). `GenerationProvenance` is engine-owned
 * and gains the fields in the same wave; this reads them structurally so
 * the renderers are right on the day they land and honest until then.
 */
export interface ProvenanceExtras {
  /** The sheet's own spelling of the case id, when the run's id was qualified (`BE:PL_03_01` → `PL_03_01`). */
  sheetCaseId: string | null;
  sheet: string | null;
  category: string | null;
  /** The sheet's recorded result — `passed` / `failed` / `blocked` — or null when it recorded nothing. */
  sheetVerdict: string | null;
  /** Every Expected line was record-only: the case has no oracle and ends in review with its captures. */
  recordOnly: boolean;
}

export function provenanceExtras(bundle: Pick<ProofBundle, 'generatedBy'> | null | undefined): ProvenanceExtras {
  const raw = (bundle?.generatedBy ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => (typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : null);
  return {
    sheetCaseId: str('sheetCaseId'),
    sheet: str('sheet'),
    category: str('category'),
    sheetVerdict: str('knownResult'),
    recordOnly: raw['recordOnly'] === true,
  };
}

/**
 * How a case id is shown: the sheet's own spelling when the run qualified it
 * (two sheets carrying `PL_03_01`, or `TSH_01_01` six times in one), with the
 * qualified id kept beside it so the ledger row and a `--rerun-case` can be
 * matched by eye. Null `qualified` when the two are one and the same.
 */
export function displayCaseId(caseId: string, sheetCaseId: string | null | undefined): { shown: string; qualified: string | null } {
  if (!sheetCaseId || sheetCaseId === caseId) return { shown: caseId, qualified: null };
  return { shown: sheetCaseId, qualified: caseId };
}

/** `EC · Hiring` — the sheet and its category, whichever of the two the row carries. */
export function sheetLabel(extras: Pick<ProvenanceExtras, 'sheet' | 'category'>): string | null {
  const parts = [extras.sheet, extras.category].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The slice of a catalog case `recordOnlyCase` reads — structural, so the CLI's outcome fits too. */
export interface CaseLike {
  verdict: string;
  status?: string | null | undefined;
  reason?: string | null | undefined;
  bundle?: Pick<ProofBundle, 'generatedBy'> | null | undefined;
}

/**
 * A case that ended in `review` because it was WHOLLY record-only (CG-09:
 * the sheet's Expected lines all say "บันทึกค่าที่ระบบแสดงจริง" — record what
 * the system shows; there is no oracle to assert against). Distinct from
 * proved-? (a wording near-miss awaiting a human): that one has a bundle
 * status of `needs-review`, this one has captures and no claim. Read from
 * the provenance stamp first, the outcome's own reason second.
 */
export function recordOnlyCase(c: CaseLike): boolean {
  if (c.verdict !== 'review') return false;
  if (provenanceExtras(c.bundle).recordOnly) return true;
  if (c.status === 'needs-review') return false;
  return /observed only|record(?:ed)?[- ]only|no oracle/i.test(c.reason ?? '');
}

/** One value a record-only case captured, named as the flow saved it. */
export interface Capture {
  name: string;
  value: string;
}

/**
 * The captures a record-only case is judged by: the run's saved variables
 * (`record_<n>` first, the author's naming rail), then the recorded value of
 * every `saveText`/`saveCount` step. These are what a reader compares to the
 * sheet's open question; a review row with no captures listed would be a
 * verdict colour over nothing.
 */
export function recordedCaptures(bundle: Pick<ProofBundle, 'variables' | 'steps'> | null | undefined): Capture[] {
  if (!bundle) return [];
  const out: Capture[] = [];
  const seen = new Set<string>();
  const variables = Object.entries(bundle.variables ?? {});
  const ordered = [...variables.filter(([k]) => /^record[_-]/i.test(k)), ...variables.filter(([k]) => !/^record[_-]/i.test(k))];
  for (const [name, value] of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: String(value) });
  }
  for (const step of bundle.steps ?? []) {
    if (step.superseded || (step.action !== 'saveText' && step.action !== 'saveCount')) continue;
    const name = typeof step.detail?.['as'] === 'string' ? (step.detail['as'] as string) : `step ${step.index}`;
    if (seen.has(name)) continue;
    const value = step.detail?.['actual'] ?? step.detail?.['value'] ?? step.detail?.['saved'];
    if (value === undefined || value === null) continue;
    seen.add(name);
    out.push({ name, value: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  return out;
}

/**
 * The suite-level split every roll-up prints: proved / test-failed / awaiting
 * review / no verdict (the harness alone broke) / never ran. Counted apart
 * on purpose — the first cut of the suite index counted every non-pass as a
 * failure, so a catalog whose harness fell over on twenty rows read as
 * twenty product defects (the false-failure audit in `src/api/CLAUDE.md`).
 */
export interface VerdictCounts {
  passed: number;
  failed: number;
  review: number;
  noVerdict: number;
  blocked: number;
  total: number;
}

export function countVerdicts(cases: readonly { verdict: string; status?: string | null | undefined }[]): VerdictCounts {
  const counts: VerdictCounts = { passed: 0, failed: 0, review: 0, noVerdict: 0, blocked: 0, total: cases.length };
  for (const c of cases) {
    if (c.verdict === 'passed') counts.passed += 1;
    else if (c.verdict === 'review') counts.review += 1;
    else if (c.verdict === 'blocked' || c.verdict === 'never-ran') counts.blocked += 1;
    else if (c.status === 'error') counts.noVerdict += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** `3 of 5 passed · 1 failed · 1 recorded only` — the breakdown after the headline count. */
export function describeVerdictCounts(counts: VerdictCounts, labels: Partial<Record<keyof VerdictCounts, string>> = {}): string {
  const parts = [`${counts.passed} of ${counts.total} passed`];
  if (counts.failed > 0) parts.push(`${counts.failed} ${labels.failed ?? 'failed'}`);
  if (counts.review > 0) parts.push(`${counts.review} ${labels.review ?? 'awaiting review'}`);
  if (counts.noVerdict > 0) parts.push(`${counts.noVerdict} ${labels.noVerdict ?? 'no verdict'}`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} ${labels.blocked ?? 'never ran'}`);
  return parts.join(' · ');
}
