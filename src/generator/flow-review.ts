/**
 * The authoring review: a second look at an authored flow, against the
 * codebase and the documents, before it is ever run.
 *
 * The commonest way an authored case ends in `dead-end` is not a broken
 * application — it is a step the author wrote with nothing behind it: a
 * control named from the requirement's wording rather than the tree, a
 * destination guessed from a label, a leg after a `workflow` step on a page
 * no capture ever saw. Every such step spends the whole escalation ladder
 * (and a healer call, and a reconstruction call) to rediscover at run time
 * that the evidence never contained it. The lints in `flow-author.ts` refuse
 * the shapes a string check can name; this is the level above them.
 *
 * Three parts, in cost order, the ladder's rule applied to authoring:
 *
 * 1. **`auditGrounding` — $0, deterministic.** Every step is checked against
 *    the evidence the author was given: a role/name selector must name
 *    something in a captured tree; a `goto`/`expectUrl` path must be a
 *    declared route, a `url=` in a tree, or a page the flow itself visits; a
 *    `workflow` goal's destination must be a declared route. Steps with
 *    nothing behind them are the findings. Nothing else is sent on.
 * 2. **One `agent`-role call, only when there are findings.** The model sees
 *    the flagged steps, the trees, the repository's context slice (routes,
 *    components, tables) and the documents the author saw, and says per step:
 *    keep, replace (a different selector / url / goal), insert preparation
 *    before it, or unsure. It may change *what a step points at*, never what
 *    it does: the action, the typed value and the asserted text are the
 *    claim, and the claim is the author's.
 * 3. **Every proposal is verified before it is applied.** A replacement
 *    selector's name must appear in a tree or in the evidence text; a
 *    replacement path must match a declared route or appear in the evidence.
 *    A proposal the evidence does not support is recorded and dropped — the
 *    model's reasoning is never the evidence, the same rule the agent rung
 *    and `goal-evidence.ts` hold at run time.
 *
 * Everything it did is on `ReviewRecord`, on the authored flow's `notes`, and
 * in the CLI narration. A review that cannot run (no agent key, a provider
 * fault) changes nothing: the flow is exactly what the author wrote.
 */

import { z } from 'zod';

import { END_SUPPORTING_CONTEXT } from '../catalog/catalog.js';
import { matchesRoutePattern } from '../context/route-match.js';
import type { FlowStep } from '../engine/runner.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import { goalDestination } from '../orchestrator/goal-evidence.js';
import { selectorGrounded, selectorName } from '../orchestrator/agent-guards.js';
import { lenientObject } from '../providers/model-output.js';
import {
  generateStructuredForModel,
  LlmFactory,
  type ModelSource,
} from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';

/** What the author was given, handed on so the reviewer judges by the same evidence. */
export interface ReviewEvidence {
  url?: string | undefined;
  /** The start page's tree. */
  axTree?: string | undefined;
  /** The destination page's tree, when a journey capture read one. */
  journeyTree?: string | undefined;
  /** The probe report — controls behind disclosures. */
  interactions?: string | undefined;
  /** The repository's prompt slice: routes, components, tables, existing tests. */
  projectContext?: string | undefined;
  /** Route patterns the repository declares. */
  declaredRoutes?: readonly string[] | undefined;
  /**
   * The request as the author saw it — the claim, the sheet row, and the
   * context documents. The documents are the part the reviewer reads here.
   */
  prompt: string;
}

export type ReviewSection = 'setup' | 'steps';

/** One step the audit could not ground, and why. */
export interface ReviewFinding {
  section: ReviewSection;
  index: number;
  step: FlowStep;
  reason: string;
  /** True when the step follows a `workflow` leg: its page was never captured. */
  afterWorkflow: boolean;
}

export type ReviewVerdict = 'keep' | 'replace' | 'insertBefore' | 'unsure';

export interface ReviewRequest {
  findings: readonly ReviewFinding[];
  setup: readonly FlowStep[];
  steps: readonly FlowStep[];
  evidence: ReviewEvidence;
}

/** One verdict, flat — narrowed in code, the `AuthoredStepSchema` convention. */
export interface ReviewDecision {
  section: ReviewSection;
  index: number;
  verdict: ReviewVerdict;
  /** For `replace`: the new selector / url / goal. For `insertBefore`: the inserted step's. */
  selector: string;
  url: string;
  goal: string;
  /** For `insertBefore` only: click | waitFor | goto | press | scrollTo | clickIfVisible. */
  action: string;
  value: string;
  reasoning: string;
  /** The line of evidence the decision rests on, quoted. */
  evidence: string;
}

export interface ReviewResponse {
  decisions: ReviewDecision[];
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface ReviewModel {
  readonly id: string;
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

/** What the review did, for the flow's notes and the report. */
export interface ReviewRecord {
  model: string;
  flagged: number;
  replaced: number;
  inserted: number;
  kept: number;
  unsure: number;
  /** Proposals the evidence did not support, each with the reason. */
  rejected: string[];
  /** One line per change, in the words a reader needs. */
  notes: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ReviewOutcome {
  setup: FlowStep[];
  steps: FlowStep[];
  record: ReviewRecord | null;
}

// --- 1. the audit -----------------------------------------------------------

const TRUNCATED = 'TREE TRUNCATED';

/** Every `url=` a tree lists — links the page actually has. */
function treeUrls(tree: string): string[] {
  return [...tree.matchAll(/\burl="?([^"\s\]]+)"?/g)].map((m) => m[1]!);
}

function pathOf(value: string): string {
  try {
    return new URL(value, 'http://x').pathname;
  } catch {
    return value;
  }
}

/** Does this path have any evidence behind it? */
function pathGrounded(
  path: string,
  evidence: ReviewEvidence,
  flowPaths: readonly string[],
): boolean {
  const wanted = pathOf(path).replace(/\/+$/, '') || '/';
  if (wanted === '/') return true;
  // The page the evidence was captured from is a page that exists.
  if (evidence.url !== undefined && pathOf(evidence.url).replace(/\/+$/, '') === wanted) return true;
  if ((evidence.declaredRoutes ?? []).some((route) => matchesRoutePattern(wanted, route))) {
    return true;
  }
  const urls = [evidence.axTree, evidence.journeyTree, evidence.interactions]
    .filter((t): t is string => t !== undefined)
    .flatMap(treeUrls)
    .map(pathOf);
  if (urls.some((u) => u === wanted || u.includes(wanted) || wanted.includes(u))) return true;
  return flowPaths.some((p) => p === wanted || p.includes(wanted));
}

function hasSelector(step: FlowStep): step is FlowStep & { selector: string } {
  return typeof (step as { selector?: unknown }).selector === 'string';
}

/**
 * The steps an author wrote with nothing behind them. Deterministic, $0.
 *
 * Declines to judge a selector against a truncated tree — past the node
 * budget, absence of evidence is not evidence of absence, the same rule
 * every grounding lint follows. Paths are still judged: a declared route
 * list is complete whatever the tree's size.
 */
export function auditGrounding(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  evidence: ReviewEvidence,
): ReviewFinding[] {
  const trees = [evidence.axTree, evidence.journeyTree, evidence.interactions].filter(
    (t): t is string => t !== undefined && t !== '',
  );
  const tree = trees.join('\n');
  const treeUsable = tree !== '' && !tree.includes(TRUNCATED);
  const flowPaths = [...setup, ...steps]
    .filter((s): s is FlowStep & { action: 'goto'; url: string } => s.action === 'goto')
    .map((s) => pathOf(s.url));

  const findings: ReviewFinding[] = [];
  let afterWorkflow = false;
  const walk = (section: ReviewSection, list: readonly FlowStep[]): void => {
    list.forEach((step, index) => {
      if (step.action === 'workflow') {
        const destination = goalDestination(step.goal);
        if (destination !== null && !pathGrounded(destination, evidence, flowPaths)) {
          findings.push({
            section,
            index,
            step,
            afterWorkflow,
            reason: `the goal ends at "${destination}", which is not a route the repository declares, a link in any captured tree, or a page the flow visits`,
          });
        }
        afterWorkflow = true;
        return;
      }
      if (step.action === 'goto' || step.action === 'expectUrl') {
        const target = step.action === 'goto' ? step.url : step.value;
        // A goto is how the flow visits a page, so it cannot be its own
        // evidence: it needs a route or a link. An expectUrl may rest on a
        // goto that came before it.
        if (!pathGrounded(target, evidence, step.action === 'goto' ? [] : flowPaths)) {
          findings.push({
            section,
            index,
            step,
            afterWorkflow,
            reason: `"${target}" is not a route the repository declares, a link in any captured tree, or a page the flow visits`,
          });
        }
        return;
      }
      if (!treeUsable) return;
      // An either/or step (CG-08) carries several selectors; each alternative
      // is audited on its own, and one finding names every ungrounded one so
      // the reviewer repoints the list as a whole.
      if (step.action === 'expectAnyVisible') {
        const ungrounded = step.selectors.filter((one) => selectorGrounded(one, tree) === false);
        if (ungrounded.length > 0) {
          findings.push({
            section,
            index,
            step,
            afterWorkflow,
            reason:
              `the accessible name in ${ungrounded.join(' ; ')} appears in no captured tree` +
              (afterWorkflow ? ' (the step follows a workflow leg, so its page was never captured)' : ''),
          });
        }
        return;
      }
      if (!hasSelector(step)) return;
      const grounded = selectorGrounded(step.selector, tree);
      if (grounded === false) {
        findings.push({
          section,
          index,
          step,
          afterWorkflow,
          reason:
            `the accessible name in ${step.selector} appears in no captured tree` +
            (afterWorkflow ? ' (the step follows a workflow leg, so its page was never captured)' : ''),
        });
      }
    });
  };
  walk('setup', setup);
  walk('steps', steps);
  return findings;
}

/**
 * Which findings are worth a model call, and which nothing could settle.
 *
 * Measured on be100-rip (2026-08-31): the run's authoring log is a wall of
 * `the review could not ground it either — No tree captured for this page
 * state`. Every one of those cost a share of an `agent` call and returned
 * `unsure`, which changes nothing. They were not the model being unhelpful —
 * they were unanswerable, and the audit already knows it.
 *
 * A **selector** finding is unanswerable when all three hold:
 *  1. it sits after a `workflow` leg, so no captured tree covers its page;
 *  2. the evidence carries no repository slice, so there is no source index to
 *     name the control from either;
 *  3. the control's own accessible name appears nowhere in the evidence text.
 *
 * Under those three, `applyReview` would reject any `replace` (nothing backs
 * the selector) and any `keep` (the audit already proved nothing backs it),
 * and the only verdict left is `unsure`. Asking is spending a call to be told
 * what the audit computed for free.
 *
 * **Path findings are always asked**, even after a workflow leg: a route is
 * settled by the repository's declared patterns or a document sentence, and
 * needs no tree at all. And a finding stays askable the moment ANY of the
 * three fails — a repository slice in the evidence, or the name appearing in a
 * document, is exactly the case where the review earns its keep.
 */
export function settleableFindings(
  findings: readonly ReviewFinding[],
  evidence: ReviewEvidence,
): { askable: ReviewFinding[]; unanswerable: ReviewFinding[] } {
  const hasProjectContext = (evidence.projectContext ?? '').trim() !== '';
  const text = evidenceText(evidence);
  const askable: ReviewFinding[] = [];
  const unanswerable: ReviewFinding[] = [];
  for (const finding of findings) {
    const step = finding.step as { selector?: unknown };
    const isSelector = typeof step.selector === 'string' && step.selector !== '';
    if (!isSelector || !finding.afterWorkflow || hasProjectContext) {
      askable.push(finding);
      continue;
    }
    const name = selectorName(step.selector as string);
    const needle = (name ?? '').trim().toLowerCase();
    if (needle !== '' && text.includes(needle)) {
      askable.push(finding);
      continue;
    }
    unanswerable.push(finding);
  }
  return { askable, unanswerable };
}

/** The note an unanswerable finding earns instead of a model call. */
export function unanswerableNote(finding: ReviewFinding): string {
  return (
    `${finding.section}[${finding.index}] ${finding.step.action}: no evidence could settle this — ` +
    'the step follows a workflow leg so no tree covers its page, the repository index is absent, ' +
    'and its control is named in no document. A capture of that page, or indexing the repository ' +
    `(--repo), is what would answer it — not another model call. (${finding.reason})`
  );
}

// --- 2. the model -----------------------------------------------------------

const INSERTABLE = new Set(['click', 'waitFor', 'goto', 'press', 'scrollTo', 'clickIfVisible']);

const DecisionFields = {
  section: z.enum(['setup', 'steps']),
  index: z.number(),
  verdict: z.enum(['keep', 'replace', 'insertBefore', 'unsure']),
  selector: z.string(),
  url: z.string(),
  goal: z.string(),
  action: z.string(),
  value: z.string(),
  reasoning: z.string(),
  evidence: z.string(),
};

const ReviewSchema = lenientObject({
  decisions: z.array(lenientObject(DecisionFields)),
});

const SYSTEM_PROMPT = `You review a browser test that was just written, BEFORE it runs, against the evidence: the page's accessibility tree(s), the application's own source index (routes, components, tables), and the documents the request came with.

Each flagged step was written with nothing behind it: its control's name is in no captured tree, or its destination is no route the application declares. Left alone, it will fail on every run against a working application. Your job is to say, per flagged step, what the evidence supports:

- keep         — the evidence DOES support it as written (quote the line).
- replace      — the step points at the wrong thing. Give the corrected selector (for a control), url (for goto/expectUrl) or goal (for workflow). Change ONLY what the step points at. Never change the action, the typed value or the asserted text: those are the claim, and the claim is the author's.
- insertBefore — the control exists but is not reachable yet: a menu to open, a page to navigate to, a list to scroll. Give ONE preparation step (action: click | waitFor | goto | press | scrollTo | clickIfVisible) that makes it reachable. The flagged step itself is then kept.
- unsure       — the evidence neither supports nor corrects it. Say so; never invent.

${DETERMINISM_RULES}

${procedure('PROCEDURE — for each flagged step, in order', [
  'For each flagged step, find the evidence line it should rest on: a node in a tree (quote its role and name), a route the source index declares (quote the pattern), or a sentence in a document (quote it).',
  'A selector must quote an accessible name EXACTLY as a tree prints it — never the requirement document\'s wording, never a label you infer. A url must be a declared route with its parameters filled from the request, or a url= the tree prints.',
  'If the tree for the step\'s page was never captured (the step follows a workflow leg), the source index is the only evidence for its page: a route and the component it renders. A control named in no evidence at all is "unsure".',
  'Prefer the smallest change that the evidence supports: replace before insertBefore, and never both for one step.',
  'Put the quoted evidence line in "evidence" — a decision with an empty "evidence" field will be discarded.',
])}

${selfCheck([
  'Every replace/insertBefore has a non-empty "evidence" quoting a tree node, route pattern or document sentence.',
  'No decision changed an action, a typed value or an asserted text.',
  'Every replacement selector uses the canonical syntax: role=<role>[name="<exact name>"] for a named control; input[type="password"] for the nameless password field.',
  'Unused fields are empty strings; "index" and "section" are copied from the flagged step exactly.',
])}`;

function stepLine(step: FlowStep): string {
  return JSON.stringify(step);
}

function buildPrompt(request: ReviewRequest): string {
  const { evidence } = request;
  const parts: string[] = [];
  parts.push('FLAGGED STEPS (the ones to decide on):');
  for (const f of request.findings) {
    parts.push(`- ${f.section}[${f.index}] ${stepLine(f.step)}\n    why flagged: ${f.reason}`);
  }
  parts.push('\nTHE WHOLE FLOW, for context (setup then steps):');
  request.setup.forEach((s, i) => parts.push(`  setup[${i}] ${stepLine(s)}`));
  request.steps.forEach((s, i) => parts.push(`  steps[${i}] ${stepLine(s)}`));
  if (evidence.axTree) parts.push(`\nACCESSIBILITY TREE of ${evidence.url ?? 'the start page'}:\n${evidence.axTree}`);
  if (evidence.journeyTree) parts.push(`\nACCESSIBILITY TREE of the journey's destination page:\n${evidence.journeyTree}`);
  if (evidence.interactions) parts.push(`\nCONTROLS BEHIND DISCLOSURES (click X reveals …):\n${evidence.interactions}`);
  if (evidence.declaredRoutes?.length) {
    parts.push(`\nROUTES THE APPLICATION DECLARES:\n${evidence.declaredRoutes.map((r) => `  ${r}`).join('\n')}`);
  }
  if (evidence.projectContext) parts.push(`\nSOURCE INDEX (what the codebase declares):\n${evidence.projectContext}`);
  // The author's prompt opens with the full supporting-document set — already
  // paid for once during authoring, and the reviewer judges steps against the
  // claim and the trees above, not against background prose. Elide everything
  // up to the sentinel; keep the claim/sheet-row half verbatim.
  const contextEnd = evidence.prompt.lastIndexOf(END_SUPPORTING_CONTEXT);
  const requestSeen =
    contextEnd >= 0
      ? `(supporting context documents elided — the author read them; the claim and sheet row follow)\n${evidence.prompt.slice(contextEnd + END_SUPPORTING_CONTEXT.length).trimStart()}`
      : evidence.prompt;
  parts.push(`\nTHE REQUEST AS THE AUTHOR SAW IT (claim, sheet row, documents):\n${requestSeen}`);
  return parts.join('\n');
}

export interface LlmFlowReviewModelOptions {
  factory?: LlmFactory | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
}

/**
 * The reviewer on the `agent` role: one small structured decision per flagged
 * step is the shape that role is matched to, and it is the role that already
 * "looks at a page and says what is reachable". A review reads evidence
 * rather than driving a browser, but the judgement is the same one.
 */
export class LlmFlowReviewModel implements ReviewModel {
  readonly id: string;
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmFlowReviewModelOptions = {}) {
    const factory = options.factory ?? new LlmFactory();
    this.#source = { factory, role: 'agent' };
    this.id = factory.forRole('agent').id;
    this.#maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.#maxRetries = options.maxRetries ?? factory.maxRetries;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: ReviewSchema,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });
    return { decisions: object.decisions, inputTokens, outputTokens };
  }
}

// --- 3. verify, then apply --------------------------------------------------

/** Every piece of evidence text the reviewer could legitimately have quoted from. */
function evidenceText(evidence: ReviewEvidence): string {
  return [
    evidence.axTree,
    evidence.journeyTree,
    evidence.interactions,
    evidence.projectContext,
    evidence.prompt,
  ]
    .filter((t): t is string => t !== undefined)
    .join('\n')
    .toLowerCase();
}

/**
 * Is a proposed selector backed by evidence? A name in a tree is the strong
 * form; a name that appears in the source index or a document (a component's
 * label, a spec's wording) is accepted when no tree covers the page. A
 * selector with no name (CSS, text=) is accepted only if its text appears in
 * the evidence.
 */
function selectorBacked(selector: string, evidence: ReviewEvidence): boolean {
  const trees = [evidence.axTree, evidence.journeyTree, evidence.interactions]
    .filter((t): t is string => t !== undefined && t !== '')
    .join('\n');
  if (trees !== '' && selectorGrounded(selector, trees) === true) return true;
  const name = selectorName(selector);
  const needle = (name ?? selector.replace(/^text=/, '').replace(/^["']|["']$/g, '')).trim().toLowerCase();
  if (needle === '') return false;
  return evidenceText(evidence).includes(needle);
}

function pathBacked(path: string, evidence: ReviewEvidence, flowPaths: readonly string[]): boolean {
  if (pathGrounded(path, evidence, flowPaths)) return true;
  return evidenceText(evidence).includes(pathOf(path).toLowerCase());
}

const canonical = (selector: string): string => withRelaxedRoleName(withQualifiedRole(selector.trim()));

/**
 * Apply a review to the flow, keeping only what the evidence supports.
 *
 * Replacements are applied **in place on the step object** (its selector, url
 * or goal), so a case list that holds the same step objects sees the change
 * without being rebuilt. Insertions are spliced into the section and into any
 * case whose steps contain the flagged step.
 */
export function applyReview(
  response: ReviewResponse,
  request: ReviewRequest,
  cases?: readonly { steps: FlowStep[] }[],
): Omit<ReviewRecord, 'model' | 'latencyMs' | 'inputTokens' | 'outputTokens'> {
  const setup = request.setup as FlowStep[];
  const steps = request.steps as FlowStep[];
  const flowPaths = [...setup, ...steps]
    .filter((s): s is FlowStep & { action: 'goto'; url: string } => s.action === 'goto')
    .map((s) => pathOf(s.url));
  const record = { flagged: request.findings.length, replaced: 0, inserted: 0, kept: 0, unsure: 0, rejected: [] as string[], notes: [] as string[] };
  const flagged = new Map(request.findings.map((f) => [`${f.section}[${f.index}]`, f]));
  const decided = new Set<string>();
  // Insertions shift later indexes; collect, then splice from the back.
  const insertions: { section: ReviewSection; index: number; step: FlowStep; anchor: FlowStep }[] = [];

  for (const d of response.decisions) {
    const key = `${d.section}[${d.index}]`;
    const finding = flagged.get(key);
    if (finding === undefined || decided.has(key)) continue; // never a step it was not asked about
    decided.add(key);
    const label = `${key} ${finding.step.action}`;
    const reject = (why: string): void => {
      record.rejected.push(`${label}: ${d.verdict} rejected — ${why}`);
    };

    if (d.verdict === 'keep') {
      record.kept += 1;
      continue;
    }
    if (d.verdict === 'unsure') {
      record.unsure += 1;
      record.notes.push(`${label}: the review could not ground it either — ${firstLine(d.reasoning)}`);
      continue;
    }
    if (d.evidence.trim() === '') {
      reject('no evidence quoted');
      continue;
    }

    if (d.verdict === 'replace') {
      const step = finding.step as FlowStep & { selector?: string; url?: string; goal?: string };
      if (step.action === 'workflow') {
        const goal = d.goal.trim();
        const destination = goal === '' ? null : goalDestination(goal);
        if (goal === '' || destination === null || !pathBacked(destination, request.evidence, flowPaths)) {
          reject('the new goal names no destination the evidence supports');
          continue;
        }
        record.notes.push(`${label}: goal "${step.goal}" → "${goal}" (${firstLine(d.reasoning)})`);
        step.goal = goal;
        record.replaced += 1;
        continue;
      }
      if (step.action === 'goto' || step.action === 'expectUrl') {
        const url = d.url.trim();
        if (url === '' || !pathBacked(url, request.evidence, flowPaths)) {
          reject(`"${url}" is backed by no declared route, tree link or document`);
          continue;
        }
        // `goto` carries the page in `url`; `expectUrl` carries the expected
        // fragment in `value` — the engine's own shapes.
        const before = step.action === 'goto' ? step.url : step.value;
        record.notes.push(`${label}: "${before}" → "${url}" (${firstLine(d.reasoning)})`);
        if (step.action === 'goto') step.url = url;
        else step.value = url;
        record.replaced += 1;
        continue;
      }
      // An either/or step is repointed as a whole list — `;`-separated, the
      // author's own convention — and every alternative must be backed, or a
      // branch that can never show would still be handed over as a claim.
      if (step.action === 'expectAnyVisible') {
        const list = d.selector
          .split(/[;\n]/)
          .map((one) => canonical(one))
          .filter((one) => one !== '' && !one.startsWith('/*'));
        if (list.length < 2) {
          reject('an expectAnyVisible needs two or more ";"-separated selectors');
          continue;
        }
        const unbacked = list.find((one) => !selectorBacked(one, request.evidence));
        if (unbacked !== undefined) {
          reject(`"${unbacked}" names nothing in any tree, the source index or the documents`);
          continue;
        }
        record.notes.push(`${label}: selectors ${step.selectors.join(' ; ')} → ${list.join(' ; ')} (${firstLine(d.reasoning)})`);
        step.selectors = list;
        record.replaced += 1;
        continue;
      }
      if (!hasSelector(step)) {
        reject('the step has nothing to repoint');
        continue;
      }
      const selector = canonical(d.selector);
      if (selector === '' || selector.startsWith('/*')) {
        reject('no usable selector proposed');
        continue;
      }
      if (!selectorBacked(selector, request.evidence)) {
        reject(`"${selector}" names nothing in any tree, the source index or the documents`);
        continue;
      }
      record.notes.push(`${label}: selector ${step.selector} → ${selector} (${firstLine(d.reasoning)})`);
      step.selector = selector;
      record.replaced += 1;
      continue;
    }

    // insertBefore
    const action = d.action.trim();
    if (!INSERTABLE.has(action)) {
      reject(`"${action}" is not a preparation step (click | waitFor | goto | press | scrollTo | clickIfVisible)`);
      continue;
    }
    let inserted: FlowStep | null = null;
    if (action === 'goto') {
      const url = d.url.trim();
      if (url === '' || !pathBacked(url, request.evidence, flowPaths)) {
        reject(`goto "${url}" is backed by no declared route, tree link or document`);
        continue;
      }
      inserted = { action: 'goto', url };
    } else if (action === 'press') {
      const value = d.value.trim();
      if (value === '') {
        reject('press needs a key');
        continue;
      }
      inserted = { action: 'press', key: value, intent: 'inserted by the authoring review' } as FlowStep;
    } else {
      const selector = canonical(d.selector);
      if (selector === '' || !selectorBacked(selector, request.evidence)) {
        reject(`"${selector}" names nothing in any tree, the source index or the documents`);
        continue;
      }
      inserted =
        action === 'clickIfVisible'
          ? ({
              action: 'when',
              visible: selector,
              then: [{ action: 'click', selector, intent: 'inserted by the authoring review' }],
              intent: 'inserted by the authoring review',
            } as unknown as FlowStep)
          : ({ action, selector, intent: 'inserted by the authoring review' } as FlowStep);
    }
    if (inserted === null) continue;
    // An assertion with a preparation step before it is still the same claim,
    // so this is allowed for any flagged step.
    insertions.push({ section: finding.section, index: finding.index, step: inserted, anchor: finding.step });
    record.notes.push(`${label}: inserted ${stepLine(inserted)} before it (${firstLine(d.reasoning)})`);
    record.inserted += 1;
  }

  // Splice from the back so earlier indexes stay valid.
  insertions.sort((a, b) => b.index - a.index);
  for (const ins of insertions) {
    const list = ins.section === 'setup' ? setup : steps;
    const at = list.indexOf(ins.anchor);
    if (at >= 0) list.splice(at, 0, ins.step);
    for (const c of cases ?? []) {
      const where = c.steps.indexOf(ins.anchor);
      if (where >= 0) c.steps.splice(where, 0, ins.step);
    }
  }

  // Flagged steps the model said nothing about are unsure by omission.
  for (const [key, f] of flagged) {
    if (!decided.has(key)) {
      record.unsure += 1;
      record.notes.push(`${key} ${f.step.action}: not decided by the review — ${f.reason}`);
    }
  }
  return record;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

// --- the reviewer -----------------------------------------------------------

export interface FlowReviewerOptions {
  model: ReviewModel;
  onLog?: ((line: string) => void) | undefined;
}

/**
 * Audit, ask, verify, apply. Never throws on a model fault: a review that
 * could not run leaves the flow exactly as authored and says so.
 */
export class FlowReviewer {
  readonly model: ReviewModel;
  readonly #onLog: ((line: string) => void) | undefined;

  constructor(options: FlowReviewerOptions) {
    this.model = options.model;
    this.#onLog = options.onLog;
  }

  async review(
    setup: FlowStep[],
    steps: FlowStep[],
    evidence: ReviewEvidence,
    cases?: readonly { steps: FlowStep[] }[],
  ): Promise<ReviewOutcome> {
    const startedMs = Date.now();
    const audited = auditGrounding(setup, steps, evidence);
    if (audited.length === 0) {
      this.#onLog?.('review: every step is grounded in the evidence — nothing to ask');
      return { setup, steps, record: null };
    }
    // Only what some evidence could actually settle is worth a call — see
    // `settleableFindings`. The rest are reported as what they are: a missing
    // capture or a missing repository index, which no model call can supply.
    const { askable: findings, unanswerable } = settleableFindings(audited, evidence);
    const unanswerableNotes = unanswerable.map(unanswerableNote);
    for (const line of unanswerableNotes) this.#onLog?.(`  · ${line}`);
    if (findings.length === 0) {
      this.#onLog?.(
        `review: ${unanswerable.length} ungrounded step(s), none of them settleable by any evidence — not asking`,
      );
      return {
        setup,
        steps,
        record: {
          model: this.model.id,
          flagged: audited.length,
          replaced: 0,
          inserted: 0,
          kept: 0,
          unsure: unanswerable.length,
          rejected: [],
          notes: unanswerableNotes,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedMs,
        },
      };
    }
    this.#onLog?.(
      `review: ${findings.length} step(s) with nothing behind them — asking the agent role to check them against the codebase and documents…` +
        (unanswerable.length > 0 ? ` (${unanswerable.length} more no evidence could settle, not asked)` : ''),
    );
    for (const f of findings) this.#onLog?.(`  · ${f.section}[${f.index}] ${f.step.action}: ${f.reason}`);

    let response: ReviewResponse;
    try {
      response = await this.model.review({ findings, setup, steps, evidence });
    } catch (error) {
      const why = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
      this.#onLog?.(`review: could not be asked — ${why}; the flow is as authored`);
      return {
        setup,
        steps,
        record: {
          model: this.model.id,
          flagged: audited.length,
          replaced: 0,
          inserted: 0,
          kept: 0,
          unsure: audited.length,
          rejected: [],
          notes: [
            `the authoring review could not run (${why}); ${findings.length} ungrounded step(s) left as authored`,
            ...unanswerableNotes,
          ],
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedMs,
        },
      };
    }
    const applied = applyReview(response, { findings, setup, steps, evidence }, cases);
    const record: ReviewRecord = {
      model: this.model.id,
      ...applied,
      // The tally a reader needs is what the AUDIT flagged, and the unsettleable
      // ones are unsure by construction — reporting only what was asked would
      // quietly shrink the problem.
      flagged: audited.length,
      unsure: applied.unsure + unanswerable.length,
      notes: [...applied.notes, ...unanswerableNotes],
      inputTokens: response.inputTokens ?? 0,
      outputTokens: response.outputTokens ?? 0,
      latencyMs: Date.now() - startedMs,
    };
    this.#onLog?.(
      `review: ${record.replaced} repointed, ${record.inserted} preparation step(s) inserted, ` +
        `${record.kept} confirmed, ${record.unsure} still unsure, ${record.rejected.length} proposal(s) rejected for lack of evidence`,
    );
    for (const line of [...record.notes, ...record.rejected]) this.#onLog?.(`  · ${line}`);
    return { setup, steps, record };
  }
}
