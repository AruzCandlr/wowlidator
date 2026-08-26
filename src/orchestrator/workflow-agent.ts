/**
 * Multi-page workflow agent.
 *
 * The deterministic runner can only click selectors it was told about. When a
 * goal sits behind unknown interstitials — a consent screen, a wizard, a
 * redirect chain that varies by tenant — the agent temporarily takes the
 * browser, drives it observe→decide→act until the goal is met, and hands
 * control back so the rest of the flow returns to the free fast path.
 *
 * The loop lives here rather than in the SDK tool runner on purpose: every
 * turn has to be budgeted, origin-checked, and screenshot-able against live
 * browser state, and keeping the model behind a one-decision-per-turn
 * interface is what lets the whole thing be tested without a network.
 */

import type { LanguageModel } from 'ai';
import type { Page } from 'playwright';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';

import { SELECTOR_SYNTAX_RULES, captureAxNodes } from '../healer/jit-healer.js';
import { CONSENT_ACCEPT_NAME, CONSENT_GATE_URL_PATTERN, acceptConsentGateAnywhere, consentGateShowing } from '../engine/sign-in.js';
import { scopeUrl, type CacheManager } from '../cache/cache-manager.js';
import type { AxNode } from '../healer/jit-healer.js';
import { decisionKey, focusTree, goalAlreadyShowing, renderTree, selectorGrounded, selectorName, unscopedDestructiveClick } from './agent-guards.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import type { AgentAction, AgentRecord } from '../engine/proof-bundle.js';
import { atGoalDestination, destinationReached, goalDestination } from './goal-evidence.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';

// 8 until 2026-08-24, then 12, then unbounded (2026-08-24): every fixed number
// priced some honest long journey wrong — a Create Plan goal is legitimately
// ~12–15 actions, and 17 workflow steps died as "gave up after 8 turns"
// mid-form with every action correct. The loop's own logic is the judge now:
// finish/fail, arriving at the goal's destination, a stall (a page-changing
// action repeated on an unchanged page, or AGENT_NO_PROGRESS_TURNS consecutive
// turns in which nothing advanced — see below), and a model failure each end it, and none of
// them can end a journey that is actually advancing. WOWLIDATOR_AGENT_MAX_STEPS
// (or `maxSteps`) reinstates a hard turn ceiling for whoever wants one.
export const DEFAULT_AGENT_MAX_STEPS = envMaxSteps() ?? Infinity;

/**
 * Consecutive turns in which nothing ADVANCED before the loop stops itself.
 *
 * This is the judge that replaced the turn ceiling for the one shape the other
 * stops cannot see: a model inventing a NEW failing action every turn (the
 * repeat guard only catches the same one twice). A turn advances when an
 * action that can change the page — click, fill, press, hover, goto — lands;
 * a turn spent only on `wait` or `scroll` (see IDLE_ACTIONS) or on failures
 * does not, however many of them succeeded. A twenty-action journey whose
 * every turn lands never meets it, which is exactly what a fixed ceiling got
 * wrong.
 *
 * Five, not three (2026-08-25). Measured on be100 the day after the ceiling
 * went: 10 of 22 error runs ended here, most of them on a dropdown leg where
 * the option's role was guessed three ways (option, menuitem, text) at 1.5 s
 * a miss — four seconds of evidence is not "the page cannot do this", it is
 * the ordinary cost of finding out how a widget is built. Three was tuned
 * for an 8 s miss; the fast-fail made it four times stricter than intended.
 */
export const AGENT_NO_PROGRESS_TURNS = 5;
/**
 * Fewer turns than a stall when EVERY action so far has been a look. Three
 * scrolls that changed nothing say the page has no more to show; two more
 * would only say it again, at a model call each.
 */
export const AGENT_LOOK_ONLY_TURNS = 3;

/**
 * Actions that look again rather than act: they can never change the
 * application's state, so repeating one is never a STALL in the sense the
 * repeat guard exists for (the same fill into the same field, four times).
 * They are also never PROGRESS — a turn spent only on them counts toward
 * AGENT_NO_PROGRESS_TURNS. Measured (be100, 2026-08-25): seven runs ended
 * as `stalled: repeated "scroll "` or `repeated "wait "` — the model asked
 * to look again, was told it already had, asked once more, and the run was
 * recorded as a harness error with the goal's control on screen.
 */
export const IDLE_ACTIONS: ReadonlySet<string> = new Set(['wait', 'scroll']);
/** Everything a `readOnly` run may do: look, look again, and answer. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([...IDLE_ACTIONS, 'finish', 'fail']);
/**
 * What a `reveal` run may do: everything read-only, plus the actions that
 * bring an EXISTING control into reach — open a menu, focus a field, follow a
 * link. Never `fill`, and never `dbCount`.
 *
 * The distinction is the one this codebase has always drawn between preparing
 * a page and performing a step, and it matters most for an ASSERTION: a claim
 * an agent typed into existence proves nothing, so the repair pass offered to
 * an assertion may reveal what is already there and no more. `dbCount` is
 * excluded for a second reason as well — it is a backend action, and a run
 * with backend testing off must not reach the database by any route.
 */
export const REVEAL_ACTIONS: ReadonlySet<string> = new Set([
  ...READ_ONLY_ACTIONS,
  'click',
  'press',
  'hover',
  'goto',
]);
/**
 * What a `wait` is worth on a page whose network is ALREADY quiet. The idle
 * wait returns at once there, and a wait that does nothing costs a model
 * turn to do nothing; a page still hydrating, or a dropdown still animating
 * its options in, is exactly what the model asked to wait for. Paid only
 * when the idle wait had nothing to wait on, so a settled page is not taxed
 * on every wait (the 2026-08-24 concern) — only on the one that would
 * otherwise be a no-op.
 */
export const WAIT_SETTLE_MS = 750;

function envMaxSteps(): number | null {
  const raw = process.env['WOWLIDATOR_AGENT_MAX_STEPS'];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
export const DEFAULT_AGENT_MAX_NODES = 60;
/** Per-action timeout while the agent holds the browser. */
export const DEFAULT_AGENT_ACTION_TIMEOUT_MS = 5_000;
/**
 * The most a post-navigation settle is worth. An app that polls or holds a
 * websocket never reaches `networkidle`, so an uncapped (or generously capped)
 * idle wait doesn't buy hydration — it buys the full timeout, on every
 * navigation, forever. Two seconds covers the quiet-page case; a page still
 * hydrating past that shows up as an unchanged tree next turn, which the
 * stall guard already knows how to read.
 */
export const NETWORK_SETTLE_MS = 2_000;
/** How long a selector gets to match ANYTHING before the action is refused as a miss. */
export const TARGET_ATTACH_MS = 1_500;

/**
 * What the agent may do with the browser.
 *
 * `press`, `scroll` and `wait` were added because they are what a *stuck* page
 * actually needs, and none of them can change data. A control below the fold,
 * a listbox that only opens on Enter, and a page that has not finished
 * hydrating are the three states a click-and-fill vocabulary cannot get out
 * of — it can only keep clicking things that are not there yet. Nothing
 * destructive belongs in this list: the agent's whole safety argument is that
 * its vocabulary cannot express a purchase or a delete except through a
 * `click` the goal explicitly asked for.
 */
export const AGENT_ACTIONS = [
  'click',
  'fill',
  'press',
  'hover',
  'scroll',
  'wait',
  'goto',
  // Read-only database validation — a SELECT count through the run's own
  // grounded, read-only session (`RunOptions.dbProbe`), so a goal like
  // "verify the number in the box matches the database" is answerable with
  // observed evidence instead of the model's word. It cannot write, which
  // keeps the vocabulary's safety argument intact.
  'dbCount',
  'finish',
  'fail',
] as const;
export type AgentActionKind = (typeof AGENT_ACTIONS)[number];

/** One further action the model is confident follows — same flat shape, no reasoning. */
const PlanStepSchema = lenientObject({
  action: z.enum(AGENT_ACTIONS),
  selector: z.string().describe('Selector, as for the main action. Empty otherwise.'),
  value: z.string().describe('Value or key name. Empty otherwise.'),
  url: z.string().describe('Absolute URL for goto. Empty otherwise.'),
});

/** How many follow-up actions one decision may carry. Each is re-verified live. */
export const AGENT_PLAN_AHEAD = 2;

const DecisionSchema = lenientObject({
  action: z.enum(AGENT_ACTIONS),
  selector: z
    .string()
    .describe(
      'Playwright selector for click/fill/press/hover, or the element to scroll into view. ' +
        'For dbCount: the database table name (schema-qualified if shown that way). Empty otherwise.',
    ),
  value: z
    .string()
    .describe(
      'Text for fill, key name for press (Enter, Escape, Tab, ArrowDown). ' +
        'For dbCount: the where clause as "column=value, column2=value2" equality pairs, or empty to count the whole table. Empty otherwise.',
    ),
  url: z.string().describe('Absolute URL for goto. Empty otherwise.'),
  reasoning: z.string().describe('One sentence: why this action moves toward the goal.'),
  next: z
    .array(PlanStepSchema)
    .describe(
      `Up to ${AGENT_PLAN_AHEAD} further actions you are CERTAIN follow, in order, each naming a control that is in the tree NOW (e.g. fill the email, then click Next). Empty when the next action depends on what appears.`,
    ),
});

export interface PlanStep {
  action: AgentActionKind;
  selector: string;
  value: string;
  url: string;
}

export interface AgentObservation {
  goal: string;
  url: string;
  axTree: string;
  /** The test case this step serves — see `RunOptions.caseContext`. */
  caseContext?: string | undefined;
  /** What has been tried so far, and how it went. */
  history: string[];
  stepsRemaining: number;
  /**
   * Why the model's previous answer for THIS turn was refused, when it was —
   * the healer's `rejected` seam applied to the agent. Present only on a
   * re-ask within one turn; the loop never re-asks twice.
   */
  feedback?: string | undefined;
}

export interface AgentDecision {
  action: AgentActionKind;
  selector: string;
  value: string;
  url: string;
  reasoning: string;
  /** Follow-ups the model planned; executed only while each still grounds in the live tree. */
  next?: PlanStep[] | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/**
 * Where a solved goal is remembered, so the next case with the same goal on
 * the same page replays it without a model turn. Backed by the healed-selector
 * cache in a run (`cacheAgentMemory`); anything with get/set in a test.
 */
export interface AgentMemory {
  get(key: string): PlanStep[] | undefined;
  set(key: string, steps: PlanStep[], model: string): void;
  forget(key: string): void;
}

/** `${origin+path} :: workflow :: ${goal}` — the goal's wording, whitespace-folded. */
export function replayKey(startUrl: string, goal: string): string {
  return `${scopeUrl(startUrl)} :: workflow :: ${goal.replace(/\s+/g, ' ').trim()}`;
}

/**
 * The healed-selector cache as agent memory. The entry's `healed` field
 * carries the JSON action list and `strategy` marks it, so the file's merge-
 * on-flush, hit counting and `wowlidator cache` tooling all apply unchanged,
 * and a replay that fails is deleted the way a stale heal is.
 */
export function cacheAgentMemory(cache: CacheManager): AgentMemory {
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry || entry.strategy !== 'workflow-replay') return undefined;
      try {
        const steps = JSON.parse(entry.healed) as PlanStep[];
        return Array.isArray(steps) ? steps : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, steps, model) {
      const [url = '', goal = ''] = key.split(' :: workflow :: ');
      cache.set({
        key,
        original: goal,
        healed: JSON.stringify(steps),
        strategy: 'workflow-replay',
        url,
        confidence: 1,
        reasoning: `${steps.length} action(s) that reached this goal, recorded for replay`,
        model,
      });
    },
    forget(key) {
      cache.delete(key);
    },
  };
}

/** Words that say HOW to get somewhere — a goal with none may be met by going there. */
const ROUTE_WORDS = /\b(via|through|menu|sidebar|side bar|nav|breadcrumb|tab|click|press|tile|card|link|button|by)\b/i;

/** Pluggable policy. One decision per call — the loop belongs to the agent. */
export interface AgentModel {
  readonly id: string;
  decide(observation: AgentObservation): Promise<AgentDecision>;
}

const SYSTEM_PROMPT = `You are driving a real web browser to reach a stated goal, one action at a time.

Each turn you see the current URL, the page's accessibility tree, and what you have already tried. Choose exactly one action:
- click  — press a control. Put a Playwright selector in "selector".
- fill   — type into a field. Selector plus "value".
- press  — send a key. Key name in "value" (Enter, Escape, Tab, ArrowDown).
           Optional "selector" focuses that element first. Use for a listbox or
           menu that only opens on a keypress, or to dismiss an overlay.
- hover  — move mouse pointer over a control. Selector in "selector". Use to open
           hover-activated flyout menus or reveal hidden sub-menus.
- scroll — bring something into view. Selector of the element to scroll to, or
           empty to scroll down one screen. The tree already lists elements
           that are off-screen, so scroll only for a control the tree shows
           and a click could not reach, or a list that renders rows lazily.
           Scrolling a page whose tree did not change afterwards is finished:
           do not scroll it again.
- wait   — let the page settle for a moment and look again. Use once, when the
           tree looks half-built or right after an action that starts a load.
           If the tree is the same after a wait, waiting longer will not
           change it: act on what is there, or call fail and say why.
- goto   — navigate directly. Absolute URL in "url".
- finish — the goal is met. Explain how you know in "reasoning".
- fail   — the goal cannot be reached from here. Explain why.

${SELECTOR_SYNTAX_RULES}

${DETERMINISM_RULES}

${procedure('EACH TURN', [
  'Is the goal already met? Compare the current URL and the tree against the goal\'s own words. If the goal names a destination path and the URL is on it, or the tree shows the state the goal describes, call finish NOW — nothing else.',
  'Read the history. Every action marked "ok" is DONE: a fill that succeeded put its value in the field, a click that succeeded pressed the control. Never repeat an ok action with the same selector and value unless the tree shows the page has been reset since. Never repeat a FAILED action unchanged — change the selector or the route.',
  'Find the first part of the goal, in the goal\'s own order, that the history does not yet show as done. That part is your next action, and only that part.',
  'If the last action changed the URL (history says "now at" a different page), and the tree looks half-built or empty, use wait once before acting on the new page.',
  'Take the smallest action that advances that part: one fill, one click, one press, as "action".',
  `Then, in "next", list up to ${AGENT_PLAN_AHEAD} further actions ONLY if you are certain they follow and their controls are in THIS tree already (fill email → click Next; fill password → click Sign in). Each is verified against the live page before it runs and stops at the first that no longer fits. Leave "next" empty when the next step depends on what the page will show.`,
])}

SIGN-IN, when the goal asks for it:
- A sign-in may take two screens: an identity field and a Next / Continue
  button first, and only THEN a password field. Fill the identity, click Next,
  wait if needed, fill the password (a nameless textbox on the password screen
  is the password; input[type="password"] addresses it), click Sign in. Once
  each — a second fill of the same field with the same value is never right.
- If the URL leaves the sign-in page after the submit click, the sign-in TOOK.
  Do not go back and fill anything again. Continue with the next part of the
  goal, or finish if that was the goal.
- A consent / terms page after sign-in: click its accept control ONLY if the
  goal asks you to accept, or the goal cannot be reached without it. Say which
  in "reasoning".

WHAT THE LOOP WILL REFUSE (so answer the way it accepts, the first time):
- A destructive click (Delete, Remove…) that does not name the row the goal
  is about. When the goal names an identifier, scope the click to it
  (role=row[name="<id>" i] >> role=button[name="Delete" i]); never
  "the first Delete button" — that acts on whatever row comes first, and
  is refused every time, not re-asked.
- A selector whose name is not in the tree. Every role name and text you
  quote must be copied from a node above — the tree is the whole evidence,
  and a name that is not in it is a guess that will be sent back to you.
- An action you already did, on a page that has not changed since. "ok" in
  the history means done. Do the NEXT thing, or finish. (A repeated wait or
  scroll is let through once you insist, but it is a turn that advances
  nothing — several in a row end the run.)
- A finish when the goal names a destination and the URL is not on it. Reach
  it first; if it cannot be reached, call fail and say what stands in the way.
- A goto to any origin but the application's own.

Rules:
- Do not repeat an action that already failed — read the history and try a different route.
- Do not take destructive actions: no delete, no purchase, no irreversible submit, unless the goal explicitly asks for it.
- Call finish as soon as the goal is satisfied. Do not keep exploring, do not "double-check" by acting again.
- If the tree shows you are already where the goal describes, call finish immediately.
- Budget is the harness's concern, never yours: choose the single most useful
  next action. Call fail only when the PAGE makes the goal impossible — the
  control does not exist anywhere reachable, the account is refused, the page
  is an error — and say which in "reasoning".
- When the tree says it is TRUNCATED, absence from it is not absence from the
  page: scroll or navigate toward where the goal's control would be before
  concluding it is missing.`;

export function buildUserPrompt(observation: AgentObservation): string {
  // The budget is deliberately NOT shown. It is the one input that changes
  // every turn with nothing on the page changing, and the documented cause of
  // a premature `fail` ("only 3 actions remain, making it impossible"). The
  // loop owns the budget; the model owns the next action.
  //
  // ORDER IS THE TOKEN BILL. Each turn is a fresh single-shot call, so the
  // only discount available is a provider's implicit prompt cache, which
  // bills the longest byte-identical PREFIX at cache rates. The prompt is
  // therefore ordered stable-first: goal and case card (never change), then
  // the tree (changes only when the page does — on be100 the tree was ~3.3k
  // of every turn's ~3.8k input tokens, resent 560 times), and only then the
  // parts that change every turn: URL, history, feedback. History before the
  // tree — the old order — moved the first differing byte in front of the
  // tree on every single turn, so the dominant repeated bytes never cached.
  const lines = [`GOAL: ${observation.goal}`];
  if (observation.caseContext) {
    lines.push(
      '',
      'THE TEST CASE THIS STEP SERVES (context for judgment — the GOAL above is still the only thing to do):',
      observation.caseContext,
    );
  }
  lines.push('', 'Accessibility tree:', observation.axTree);
  lines.push('', `Current URL: ${observation.url}`);
  if (observation.history.length > 0) {
    // Late turns do not need the verbatim log of every early action — the last
    // few carry the state that matters, and a capped list keeps turn N from
    // paying for turns 1…N-1 twice over. Eight is enough for the guards that
    // read history through the model's eyes (a repeat, a stall) to still see
    // their evidence.
    const MAX_HISTORY_LINES = 8;
    const history = observation.history;
    lines.push('', 'What you have tried:');
    if (history.length > MAX_HISTORY_LINES) {
      lines.push(`  - (${history.length - MAX_HISTORY_LINES} earlier action(s) elided)`);
    }
    for (const entry of history.slice(-MAX_HISTORY_LINES)) lines.push(`  - ${entry}`);
  }
  // Feedback stays last: the re-ask then shares a byte-identical prefix with
  // the turn's first ask, and recency favours the correction.
  if (observation.feedback) {
    lines.push('', `Your previous answer for this turn was REFUSED: ${observation.feedback}`);
  }
  return lines.join('\n');
}

export interface LlmAgentModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `agent` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

/**
 * One structured decision per turn. Deliberately a small output — the agent
 * loop, not the model, owns budgeting and safety, so a weaker free model is
 * enough here as long as it can pick an action from the tree in front of it.
 */
export class LlmAgentModel implements AgentModel {
  readonly id: string;

  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmAgentModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.id = options.id ?? 'custom:agent';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'agent' };
      this.id = options.id ?? factory.forRole('agent').id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 2048;
  }

  async decide(observation: AgentObservation): Promise<AgentDecision> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: DecisionSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(observation),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      action: object.action,
      // Same accessible-name case mismatch the generator and healer hit — the
      // model is reading names out of the AX tree we gave it. See
      // `src/engine/selector.ts`.
      selector: withRelaxedRoleName(withQualifiedRole(object.selector)),
      value: object.value,
      url: object.url,
      reasoning: object.reasoning,
      next: (object.next ?? []).slice(0, AGENT_PLAN_AHEAD).map((step) => ({
        action: step.action,
        selector: withRelaxedRoleName(withQualifiedRole(step.selector)),
        value: step.value,
        url: step.url,
      })),
      inputTokens,
      outputTokens,
    };
  }
}

export interface WorkflowAgentOptions {
  model: AgentModel;
  /**
   * Optional hard ceiling on model turns. Unbounded by default — the loop's
   * own logic decides when to stop (finish/fail, destination reached, stall,
   * no-progress, model failure). Set this (or WOWLIDATOR_AGENT_MAX_STEPS) to
   * cap it anyway, e.g. the capture pilot's deliberately short leash.
   */
  maxSteps?: number | undefined;
  maxAxNodes?: number | undefined;
  actionTimeoutMs?: number | undefined;
  /**
   * Origins the agent may navigate to. Defaults to the origin it started on,
   * so a confused agent cannot wander onto the public internet.
   */
  allowedOrigins?: string[] | undefined;
  /** Called after every action, for screenshot capture. */
  onAction?: ((page: Page, action: AgentAction) => Promise<void>) | undefined;
  /** Remembered solutions; see `AgentMemory`. A run passes the cache-backed one per call. */
  memory?: AgentMemory | undefined;
}

export interface RunOptions {
  memory?: AgentMemory | undefined;
  /**
   * Look, never touch. Every action that could change the application —
   * click, fill, press, hover, goto, dbCount — is refused before it runs;
   * only `wait`, `scroll`, `finish` and `fail` are left.
   *
   * The rung this exists for asks the agent a READING question ("where on
   * this page is the value for that label?") and verifies the answer
   * deterministically afterwards. The ladder's standing rule is that an
   * assertion is never offered the agent, because "a claim it made true
   * proves nothing" — and that rule is about ACTING. Forbidding action
   * structurally is what makes a reading question safe to ask of an
   * assertion, rather than a promise in a prompt a model may quietly break.
   */
  readOnly?: boolean | undefined;
  /**
   * Which actions this run may take at all. `readOnly: true` is the strictest
   * form (`READ_ONLY_ACTIONS`) and wins over this; `REVEAL_ACTIONS` is the
   * healing pass offered to an assertion — it may open, focus and navigate to
   * what already exists, but never type. Absent means the full vocabulary.
   */
  allowedActions?: ReadonlySet<string> | undefined;
  /**
   * The test case this workflow step serves — claim, expected output, persona
   * — a compact card stamped on the flow at authoring (`Flow.caseContext`).
   * Context, never instructions: the goal stays the only thing the agent
   * pursues, but a model that knows the claim stops rediscovering what the
   * spec already states (measured on be100: turns spent proving a filter
   * absent that the sheet's own note says was removed).
   */
  caseContext?: string | undefined;
  /**
   * A deterministic script recorded on the flow's own `workflow` step by an
   * earlier successful run (see `withWorkflowScripts`). Tried after the
   * cache-backed memory and before any model turn, under the same replay
   * rules: every selector must still ground in the live tree, and a named
   * destination must actually be reached. Unlike memory, the script travels
   * in the flow file — it survives a cleared cache and a different machine.
   */
  script?: readonly PlanStep[] | undefined;
  /**
   * Read-only database access for the `dbCount` action: count the rows of
   * `table` matching the `where` equalities, through the run's own grounded
   * read-only session (the runner wires this to its `DbActions`). Throws
   * with a human-readable reason on grounding or availability problems —
   * the message goes into the agent's history as the action's failure.
   * Absent when no database is configured, and `dbCount` then fails with
   * advice to verify through the page instead.
   */
  dbProbe?: AgentDbProbe | undefined;
}

/** See `RunOptions.dbProbe`. The observed count is evidence; a thrown message is the failure. */
export type AgentDbProbe = (table: string, where: Record<string, string>) => Promise<number>;

/** `"status=ACTIVE, type=HR"` → `{ status: 'ACTIVE', type: 'HR' }`. */
export function parseWherePairs(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`dbCount where must be "column=value" pairs — could not read ${JSON.stringify(trimmed)}`);
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The replayable part of an agent journey: the actions that succeeded, minus
 * the model's own `finish`/`fail` (a replay re-proves arrival against the
 * page, not against a claim) and `wait` (it waits on state that replay
 * timing won't reproduce). The single writer for both persistence paths —
 * `AgentMemory` entries and the flow file's `script` field.
 */
export function scriptOf(actions: readonly AgentAction[]): PlanStep[] {
  return actions
    .filter((a) => a.ok && a.action !== 'finish' && a.action !== 'fail' && a.action !== 'wait')
    .map((a) => ({
      action: a.action as AgentActionKind,
      selector: a.selector ?? '',
      value: a.value ?? '',
      // For a goto the recorded url is where it landed, which is the target.
      url: a.action === 'goto' ? a.url : '',
    }));
}

export interface WorkflowResult extends AgentRecord {}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Every origin an absolute URL in the goal's text points at. */
function originsNamedIn(goal: string): string[] {
  const out: string[] = [];
  for (const match of goal.matchAll(/\bhttps?:\/\/[^\s"'<>()\]]+/gi)) {
    const origin = originOf(match[0].replace(/[.,;:!?)\]'"]+$/, ''));
    if (origin !== null && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export class WorkflowAgent {
  readonly model: AgentModel;

  readonly #maxSteps: number;
  readonly #maxAxNodes: number;
  readonly #actionTimeoutMs: number;
  readonly #allowedOrigins: string[] | undefined;
  readonly #onAction: ((page: Page, action: AgentAction) => Promise<void>) | undefined;
  readonly #memory: AgentMemory | undefined;

  constructor(options: WorkflowAgentOptions) {
    this.model = options.model;
    this.#maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_AGENT_MAX_NODES;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_AGENT_ACTION_TIMEOUT_MS;
    this.#allowedOrigins = options.allowedOrigins;
    this.#onAction = options.onAction;
    this.#memory = options.memory;
  }

  /**
   * Drive `page` until `goal` is met or the budget runs out. Always resolves —
   * failure is reported in the record, never thrown, so the run can continue
   * and the report can show what the agent tried.
   */
  async run(page: Page, goal: string, runOptions: RunOptions = {}): Promise<WorkflowResult> {
    const startedMs = Date.now();
    // Reset here, not at declaration: the agent is one instance shared across
    // every workflow step of a run, and a flag that stuck from a PRIOR step's
    // goal would mark every step after a looked-only one the same way,
    // whether or not it was.
    this.#lookedOnly = false;
    const memory = runOptions.memory ?? this.#memory;
    // What this run may do at all: `readOnly` is the strictest form, an
    // explicit set is the middle ground (the reveal pass), absent is the full
    // vocabulary. Enforced before a decision is acted on, so a restriction is
    // a guarantee rather than a line in a prompt.
    const allowedActions: ReadonlySet<string> | null =
      runOptions.readOnly === true ? READ_ONLY_ACTIONS : (runOptions.allowedActions ?? null);
    this.#dbProbe = runOptions.dbProbe ?? null;
    const actions: AgentAction[] = [];
    const history: string[] = [];
    // The origins the agent may navigate to: the caller's list, else the page
    // it started on, else whatever origin the GOAL itself names. An empty
    // list used to mean "anywhere" by way of a short-circuit (`allowed.length
    // > 0 && …`) — a page on about:blank let a confused agent leave for the
    // public internet. Empty now means no goto at all, which is the safe
    // reading of "nobody said where".
    const allowed =
      this.#allowedOrigins ??
      [originOf(page.url()), ...originsNamedIn(goal)].filter((o): o is string => !!o);
    // Where the step began, for the one check that can end the budget early.
    // Read once: every later comparison is against the state the goal was
    // handed, not against the previous turn.
    const startUrl = page.url();

    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let success = false;
    let summary = 'agent stopped without reaching the goal';
    // Consecutive turns in which nothing succeeded. The stop that replaced the
    // turn ceiling: reset by any ok action, so it can only end a loop that is
    // demonstrably not advancing.
    let turnsWithoutProgress = 0;

    // What has been DONE and not undone: the key of every ok action, cleared
    // whenever the URL moves (a new page is a new state, and the same click
    // may be right again there).
    const doneHere = new Set<string>();
    // Interstitials this loop has already cleared-and-returned from — once
    // per distinct accept, so a gate that will not stay cleared becomes a
    // recorded stall rather than a loop (spec F2's guard).
    const interstitialReturns = new Set<string>();
    // Whether the agent has done anything BEYOND clearing gates. An accept
    // that fires before any real work is an obstacle in front of the step's
    // own page (PL_02_05's shape — return to it); one that fires after the
    // agent already advanced is a gate ON THE WAY somewhere (the
    // two-interstitials journey — returning would destroy the progress).
    let progressMade = false;
    let lastUrlSeen = startUrl;
    // Where the agent is going: the step's page until a goto asks for
    // another. A gate cleared mid-run returns here, never to the app's home.
    let intendedUrl = startUrl;
    const destination = goalDestination(goal);

    // ---- Zero-call rungs, in cost order, before any model turn ----------
    //
    // Measured across 81 workflow steps: 3.8 model turns each, ~3,350 input
    // tokens a turn — the single largest token sink in a run and the role
    // that trips a per-minute quota first. Most of those turns were spent
    // on legs that need no judgment at all: a goal this run (or an earlier
    // one) already solved on this page, a consent gate standing in front of
    // the page, a link in the tree that points exactly where the goal ends.
    // Each is handled here deterministically and recorded as an action, so
    // the model is asked only for the part that genuinely needs it.
    const key = /^https?:/.test(startUrl) ? replayKey(startUrl, goal) : null;
    const remembered = key !== null && memory ? memory.get(key) : undefined;
    if (remembered && remembered.length > 0) {
      const replayed = await this.#replay(page, remembered, allowed, actions, history, startUrl, goal);
      if (replayed === null) {
        summary = `replayed ${remembered.length} recorded action(s) from an earlier run that reached this goal — no model turn spent`;
        return this.#result(goal, true, summary, actions, 0, startedMs, 0, 0);
      }
      memory?.forget(key as string);
      history.push(`(a remembered solution was replayed and failed at action ${replayed + 1}; asking the model)`);
    }
    // The flow file's own recorded script — the same rung with a different
    // home. Skipped when it is byte-identical to the memory that just failed:
    // replaying the same steps twice teaches nothing and spends a page load.
    const script = runOptions.script;
    if (
      script &&
      script.length > 0 &&
      JSON.stringify(script) !== JSON.stringify(remembered ?? null)
    ) {
      const replayed = await this.#replay(page, script, allowed, actions, history, startUrl, goal);
      if (replayed === null) {
        this.#remember(key, memory, actions);
        summary = `replayed ${script.length} scripted action(s) recorded on the flow itself — no model turn spent`;
        return this.#result(goal, true, summary, actions, 0, startedMs, 0, 0);
      }
      history.push(`(the flow's recorded script failed at action ${replayed + 1}; asking the model)`);
    }
    // **The state the goal describes is already showing.** The cheapest rung
    // of all: no model call, no action, no turn. Measured (be100,
    // 2026-08-26) six of ten agent runs in one pass ended after one or two
    // turns having found the dialog the goal asked for already open — the
    // authored step before them had opened it. Asking the tree first turns
    // that whole leg into a lookup.
    const showing = goalAlreadyShowing(goal, await captureAxNodes(page, Number.MAX_SAFE_INTEGER));
    if (showing !== null) {
      history.push(`(the goal's own surface "${showing}" is already showing; nothing to do)`);
      return this.#result(
        goal,
        true,
        `"${showing}" is already open — the state this goal describes was reached before the leg began, so no model turn was spent`,
        actions,
        0,
        startedMs,
        0,
        0,
      );
    }

    const preflight = await this.#preflight(page, goal, startUrl, destination, allowed, actions, history);
    if (preflight !== null) {
      this.#remember(key, memory, actions);
      return this.#result(goal, true, preflight, actions, 0, startedMs, 0, 0);
    }
    progressMade = actions.some((a) => a.ok && a.action !== 'wait' && a.action !== 'scroll' && !/consent gate/.test(a.reasoning));

    // The rendered tree the last turn saw. "Already done" holds only while
    // the page is UNCHANGED — the guard's own stated rule — and the URL is
    // too coarse a proxy for that: picking one entry of a multi-select leaves
    // the URL alone while the page visibly moves on, and re-opening the same
    // dropdown for the next entry is then the RIGHT action. Measured (be100
    // PL_03_17, live): a Company multi-select needing three picks was refused
    // as a stall on its second open. A fill into a field whose value the tree
    // cannot show (a password) changes nothing here, so PB_03_01's repeated
    // password fills stay refused.
    let lastTreeSeen: string | null = null;

    for (;;) {
      // A configured ceiling still holds (the capture pilot's short leash,
      // WOWLIDATOR_AGENT_MAX_STEPS); the default is no ceiling at all, and
      // then only the logic below — finish/fail, arrival, a stall, no
      // progress, a model failure — ends the loop.
      if (turns >= this.#maxSteps) {
        summary = `agent gave up after ${turns} turns without reaching the goal`;
        break;
      }
      turns += 1;

      // A gate the session steered the agent into since the last turn is
      // cleared here, on the URL's say-so alone (the content check every
      // turn would cost a locator pass on pages that have no gate); the
      // preflight keeps the content-based detection for the page a gate
      // renders in place on.
      if (CONSENT_GATE_URL_PATTERN.test(page.url())) {
        // Where to go once the gate is cleared: the page a goto asked for
        // and was redirected away from; the step's own page when nothing
        // has been done yet; nowhere — stay where the accept lands — when
        // the gate stands on the way of a journey already under way.
        const returnTo = intendedUrl !== startUrl ? intendedUrl : progressMade ? null : startUrl;
        const gate = await this.#clearConsentGate(page, goal, startUrl, returnTo, actions, history, `on turn ${turns}`);
        if (gate === 'arrived') {
          success = true;
          summary = `reached ${page.url()}, the destination the goal names, after clearing a consent gate on turn ${turns}`;
          break;
        }
      }
      if (page.url() !== lastUrlSeen) {
        doneHere.clear();
        lastUrlSeen = page.url();
      }
      // Goal-focused: the nodes the goal names survive the budget cut.
      const all = await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
      const axTree = renderTree(focusTree(all, goal, this.#maxAxNodes), all.length);
      if (lastTreeSeen !== null && axTree !== lastTreeSeen) doneHere.clear();
      lastTreeSeen = axTree;

      // One decision per turn, with at most ONE informed re-ask when the
      // first answer is one the loop can see is wasted: a selector that names
      // nothing in the tree, an ok action repeated on an unchanged page, a
      // finish that the goal's own destination contradicts. The re-ask is
      // the whole value — it is the first ask that knows what was wrong.
      let decision: AgentDecision | null = null;
      let feedback: string | undefined;
      let refusedTurn = false;
      for (let ask = 0; ask < 2 && decision === null; ask += 1) {
        let candidate: AgentDecision;
        try {
          candidate = await this.model.decide({
            goal,
            url: page.url(),
            axTree,
            ...(runOptions.caseContext === undefined ? {} : { caseContext: runOptions.caseContext }),
            // Snapshot: the agent keeps mutating `history`, and an observation
            // handed to the model must not change under it after the fact.
            history: [...history],
            stepsRemaining: this.#maxSteps - turns,
            ...(feedback === undefined ? {} : { feedback }),
          });
        } catch (error) {
          summary = `agent model failed: ${describe(error)}`;
          return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens);
        }
        inputTokens += candidate.inputTokens ?? 0;
        outputTokens += candidate.outputTokens ?? 0;

        const refusal =
          (allowedActions !== null && !allowedActions.has(candidate.action)
            ? `"${candidate.action}" is not available to this run — it may only ` +
              `${[...allowedActions].filter((one) => one !== 'finish' && one !== 'fail').join(', ')}. ` +
              'Use one of those, or answer now with finish or fail'
            : null) ??
          this.#refuse(candidate, axTree, doneHere, destination, page.url(), ask, goal);
        if (refusal === null) {
          decision = candidate;
        } else if (ask === 0) {
          feedback = refusal;
          history.push(`(refused before acting: ${refusal})`);
        } else {
          // Refused twice. The cheapest honest outcome for each kind: a
          // repeated action is a STALL, not a turn worth spending; an
          // ungrounded selector or a contradicted finish falls through to act
          // and fail fast, which is evidence the model can read next turn.
          if (refusal.startsWith('stalled')) {
            summary = `agent ${refusal}`;
            actions.push(this.#record(actions.length, candidate, page.url(), false, 0, refusal));
            return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens);
          }
          if (refusal.startsWith('destructive')) {
            // Never acted on, however the model insists: recorded as a
            // failed action so the report shows what was refused and why,
            // and the turn counts as no progress — the run goes on, because
            // the right row may still be found (or `fail` said honestly).
            actions.push(this.#record(actions.length, candidate, page.url(), false, 0, refusal));
            history.push(`click ${candidate.selector} — REFUSED: ${refusal}`);
            refusedTurn = true;
            break;
          }
          if (candidate.action === 'finish') {
            // An unverified finish is recorded as one — never as success.
            summary = `agent claimed finish, but ${refusal}`;
            actions.push(this.#record(actions.length, candidate, page.url(), false, 0, refusal));
            return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens);
          }
          decision = candidate;
        }
      }
      if (decision === null) {
        if (refusedTurn) {
          turnsWithoutProgress += 1;
          if (turnsWithoutProgress >= AGENT_NO_PROGRESS_TURNS) {
            summary =
              `agent stalled: nothing advanced in ${turnsWithoutProgress} consecutive turns` +
              ` (last refusal: ${actions[actions.length - 1]?.error ?? ''})`;
            break;
          }
        }
        continue;
      }

      if (decision.action === 'finish') {
        success = true;
        summary = decision.reasoning;
        actions.push(this.#record(actions.length, decision, page.url(), true, 0));
        break;
      }

      if (decision.action === 'fail') {
        summary = `agent reported the goal is unreachable: ${decision.reasoning}`;
        actions.push(this.#record(actions.length, decision, page.url(), false, 0));
        break;
      }

      // The decision plus whatever it planned after itself. A follow-up is
      // executed only while it still grounds in the LIVE tree and is not
      // already done — the page after the first action is not the page the
      // plan was written on — and the first follow-up that fails or no longer
      // grounds hands control back to the model. Follow-ups cost no turn.
      const queue: AgentDecision[] = [
        decision,
        ...(decision.next ?? []).map((step) => ({ ...step, reasoning: `planned after: ${decision.reasoning}` })),
      ];
      const turnStart = actions.length;
      let arrived = false;
      for (let q = 0; q < queue.length && !arrived; q += 1) {
        const current = queue[q]!;
        if (q > 0) {
          if (current.action === 'finish' || current.action === 'fail') break;
          const liveTree = renderTree(
            focusTree(await captureAxNodes(page, Number.MAX_SAFE_INTEGER), goal, this.#maxAxNodes),
            0,
          );
          if (current.selector !== '' && selectorGrounded(current.selector, liveTree) === false) {
            history.push(`(planned ${current.action} ${current.selector} skipped: not in the tree after the previous action)`);
            break;
          }
          if (doneHere.has(decisionKey(current))) break;
          if (page.url() !== lastUrlSeen) {
            doneHere.clear();
            lastUrlSeen = page.url();
          }
        }

        const actionStarted = Date.now();
        const urlBefore = page.url();
        let ok = true;
        let error: string | undefined;

        try {
          await this.#act(page, current, allowed);
        } catch (caught) {
          ok = false;
          error = describe(caught);
        }

        const record = this.#record(
          actions.length,
          current,
          page.url(),
          ok,
          Date.now() - actionStarted,
          error,
        );
        actions.push(record);
        // What the model needs to not repeat itself: WHICH value went into
        // WHICH field, and whether the page moved. Without the value, four
        // password fills read as four identical "fill role=textbox — ok" lines
        // and the model cannot tell it already typed the thing (PB_03_01,
        // live). A password-shaped value is masked to its length — the model
        // knows what it typed; the record must not.
        const target = current.selector || current.url;
        const typed =
          current.action === 'fill' && current.value !== ''
            ? ` = ${/password|passwd|pwd/i.test(current.selector) ? `•••• (${current.value.length} chars)` : JSON.stringify(current.value)}`
            : '';
        const moved = page.url() === urlBefore ? `still at ${page.url()}` : `moved ${urlBefore} → ${page.url()}`;
        const note = this.#lastTargetNote === null ? '' : ` (${this.#lastTargetNote})`;
        this.#lastTargetNote = null;
        history.push(
          ok
            ? `${current.action} ${target}${typed} — ok${note}, ${moved}${q > 0 ? ' (planned)' : ''}`
            : `${current.action} ${target}${typed} — FAILED: ${error ?? ''}`,
        );

        if (ok && page.url() === urlBefore) doneHere.add(decisionKey(current));
        if (ok && current.action === 'goto' && !CONSENT_GATE_URL_PATTERN.test(current.url)) intendedUrl = current.url;

        // **An interstitial cleared mid-goal returns to the step's own page**
        // (docs/consent-gate-recovery-spec.md, F2). Accepting a consent gate
        // dumps the agent on the app's home landing; left to judgment, the
        // model re-navigates by menu label and lands on the wrong page —
        // measured: the one run that returned to the step's starting URL passed
        // (PL_02_06) and the two that guessed went red. So when the goal names
        // no destination of its own, an accept-shaped click that navigated away
        // from the page the step began on is followed by a deterministic return
        // to that page — no model turn spent, at most once per distinct accept.
        const acceptShaped =
          current.action === 'click' && CONSENT_ACCEPT_NAME.test(selectorName(current.selector) ?? '');
        if (
          ok &&
          !progressMade &&
          destination === null &&
          acceptShaped &&
          page.url() !== startUrl &&
          /^https?:/.test(startUrl) &&
          !interstitialReturns.has(decisionKey(current))
        ) {
          interstitialReturns.add(decisionKey(current));
          await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
          history.push(`(cleared an interstitial — returned to the goal's page ${startUrl})`);
        }
        // Anything beyond clearing a gate, waiting, or scrolling is forward
        // progress: after it, an accept-shaped click is a gate met ALONG the
        // journey, and the loop must not undo the journey to get behind it.
        if (ok && !acceptShaped && current.action !== 'wait' && current.action !== 'scroll') {
          progressMade = true;
        }

        if (this.#onAction) await this.#onAction(page, record);

        // **Arriving is finishing.** If the goal names a destination and the page
        // has just reached it, the goal is met in the only part of it a machine
        // can check, and there is nothing left to spend turns on.
        //
        // Without this the agent keeps deciding after the thing was done, and it
        // does not merely waste the budget — it exhausts it and then reports
        // failure. Live (PB_03_01, 2026-08-19): a login that had already
        // succeeded at turn 5 was followed by three more password fills into a
        // field the agent could not read back, and the step was recorded as
        // "gave up after 8 turns" from the destination page itself. 37 seconds,
        // a reconstruction model call, a `high` defect against a working
        // application, and a run reported `error`.
        //
        // Only the destination rule is consulted here; see `goalEvidence` for
        // why the sign-in rule is a post-hoc verdict and never a mid-flight stop.
        if (ok && destinationReached(goal, startUrl, page.url())) {
          success = true;
          summary = `reached ${page.url()}, the destination the goal names, after ${turns} turn(s)`;
          arrived = true;
        }
        if (!ok) break;
      }
      if (arrived) break;

      // The no-progress judge. A turn in which an action that can change
      // the page landed resets it; a turn in which nothing did — every action
      // failed, the only decision fell through a refusal and missed, or the
      // turn was spent looking again (a wait, a scroll: IDLE_ACTIONS) —
      // brings the stop closer. This is what lets the loop run unbounded: a
      // journey that keeps landing actions keeps going, and one that keeps
      // missing, or keeps looking, ends on evidence rather than on a turn
      // number.
      if (actions.slice(turnStart).some((a) => a.ok && !IDLE_ACTIONS.has(a.action))) {
        turnsWithoutProgress = 0;
      } else {
        turnsWithoutProgress += 1;
        // **A stall made only of looking is a handoff, not a failure.** When
        // EVERY action across the whole leg — not just this turn — has been
        // idle (scroll, wait), the model was never handed a real move: no
        // click, fill or press was ever attempted, ok or not. That is a fact
        // about the goal, and with a capable model it is the only way this
        // shape arises — a goal that reads as an action but is actually a
        // reading question (arithmetic over values on the page, a
        // cross-check), so the agent has nothing legitimate to press. The
        // leg ends as inconclusive-not-failed: whatever the flow asserts next
        // is the proof, exactly as `verification-deferred` treats a goal the
        // wording classifier caught up front. The whole-leg scope is
        // deliberate: a leg that landed one real action earlier and only
        // got stuck looking afterward is a different, more ordinary stall,
        // and stays on the 5-turn judge above.
        const lookedOnly = actions.length > 0 && actions.every((a) => IDLE_ACTIONS.has(a.action));
        if (lookedOnly && turnsWithoutProgress >= AGENT_LOOK_ONLY_TURNS) {
          summary =
            `agent looked and found nothing to act on: ${turnsWithoutProgress} turn(s) of scrolling and ` +
            'waiting with no control the goal could name — this is a reading question, and the ' +
            "flow's own assertions after this step are what answer it";
          this.#lookedOnly = true;
          break;
        }
        if (turnsWithoutProgress >= AGENT_NO_PROGRESS_TURNS) {
          const lastFailed = [...actions].reverse().find((a) => !a.ok);
          summary =
            `agent stalled: nothing advanced in ${turnsWithoutProgress} consecutive turns` +
            (lastFailed?.error === undefined ? '' : ` (last failure: ${lastFailed.error})`);
          break;
        }
      }
    }

    if (success) this.#remember(key, memory, actions);

    return this.#result(goal, success, summary, actions, turns, startedMs, inputTokens, outputTokens);
  }

  /**
   * Remember what worked, for the next case with this goal on this page.
   * Only the actions that succeeded, and never the model's own finish: a
   * replay re-proves arrival against the page, not against a claim.
   */
  #remember(key: string | null, memory: AgentMemory | undefined, actions: readonly AgentAction[]): void {
    if (key === null || !memory) return;
    const steps = scriptOf(actions);
    if (steps.length > 0) memory.set(key, steps, this.model.id);
  }

  /**
   * Re-run a remembered solution. Returns null when every action succeeded
   * and the goal's evidence holds; else the index of the action that failed.
   * Each selector must still ground in the live tree — a page that changed
   * under a remembered selector is exactly the case that must fall through
   * to the model rather than click something else.
   */
  async #replay(
    page: Page,
    steps: readonly PlanStep[],
    allowed: string[],
    actions: AgentAction[],
    history: string[],
    startUrl: string,
    goal: string,
  ): Promise<number | null> {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const decision: AgentDecision = { ...step, reasoning: 'replayed from an earlier run that reached this goal' };
      if (step.selector !== '') {
        const tree = renderTree(focusTree(await captureAxNodes(page, Number.MAX_SAFE_INTEGER), goal, this.#maxAxNodes), 0);
        if (selectorGrounded(step.selector, tree) === false) {
          actions.push(this.#record(actions.length, decision, page.url(), false, 0, 'not in the tree on this run'));
          return i;
        }
      }
      const started = Date.now();
      try {
        await this.#act(page, decision, allowed);
      } catch (error) {
        actions.push(this.#record(actions.length, decision, page.url(), false, Date.now() - started, describe(error)));
        return i;
      }
      const record = this.#record(actions.length, decision, page.url(), true, Date.now() - started);
      actions.push(record);
      history.push(`${step.action} ${step.selector || step.url} — ok (replayed)`);
      if (this.#onAction) await this.#onAction(page, record);
      if (destinationReached(goal, startUrl, page.url())) return null;
    }
    // No destination to check against: the replay stands on every action
    // having succeeded, as the original run's finish did. The caller's
    // post-hoc `goalEvidence` still judges the page afterwards.
    return goalDestination(goal) === null ? null : steps.length;
  }

  /**
   * A consent gate standing where the agent is: accept it, and go back to
   * the page the agent meant to be on. The zero-call rung that used to live
   * only in the preflight — measured the day after (be100, 2026-08-25), the
   * gate showed up MID-run too: a goto to the plans page was redirected to
   * /en/consent because the session had not accepted yet (the preflight's
   * 5 s poll had found no accept control on a page still hydrating under an
   * eight-way run), and the model then scrolled, waited, and reported the
   * plans controls missing — from the consent page. Three runs, all errors,
   * all with the accept control on screen by the second turn.
   *
   * `returnTo` is where the agent was going — the step's own page, or the
   * page the last goto asked for — and is where it is returned to unless the
   * goal's destination has been reached on the way. `null` means stay where
   * the accept landed: a gate met after real progress, on the way somewhere,
   * is a gate ON the journey (the two-interstitials shape), and going back to
   * the start would undo the journey to get behind it. Returns what happened
   * so the caller can stop if arriving was the whole goal.
   */
  async #clearConsentGate(
    page: Page,
    goal: string,
    startUrl: string,
    returnTo: string | null,
    actions: AgentAction[],
    history: string[],
    when: string,
  ): Promise<'none' | 'cleared' | 'arrived'> {
    // On a consent URL the gate is checked against the HYDRATED page: measured
    // (be100 PL_06_17), the step began on /en/consent while the page was still
    // a shell, the probe saw no accept control, and the model then spent two
    // of its turns on a wait and a click this rung exists to make free.
    // Polled for the gate itself rather than `networkidle` (2026-08-24): the
    // idle wait held its full 5 s on any page that keeps talking, and even
    // then only re-checked once — this ends the moment the accept control
    // renders, which on the measured page is well under a second.
    if (CONSENT_GATE_URL_PATTERN.test(page.url()) && (await consentGateShowing(page)) === null) {
      const gateDeadline = Date.now() + 5_000;
      while (Date.now() < gateDeadline && (await consentGateShowing(page)) === null) {
        await page.waitForTimeout(250);
      }
    }
    if ((await consentGateShowing(page)) === null) return 'none';
    const started = Date.now();
    const accepted = await acceptConsentGateAnywhere(page).catch(() => false);
    const decision: AgentDecision = {
      action: 'click',
      selector: 'role=button[name="Accept" i]',
      value: '',
      url: '',
      reasoning: `consent gate in front of the page, cleared ${when} without asking the model`,
    };
    actions.push(this.#record(actions.length, decision, page.url(), accepted, Date.now() - started));
    if (!accepted) return 'none';
    history.push(`(cleared a consent gate ${when})`);
    if (returnTo !== null && page.url() !== returnTo && /^https?:/.test(returnTo) && !destinationReached(goal, startUrl, page.url())) {
      await page.goto(returnTo, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
      history.push(`(returned to ${returnTo === startUrl ? "the goal's page" : 'the page the goto asked for'} ${returnTo})`);
    }
    return destinationReached(goal, startUrl, page.url()) ? 'arrived' : 'cleared';
  }

  /**
   * What can be done for the goal with no model at all, on the page as it
   * stands. Returns a success summary when the goal is thereby met, else
   * null — with whatever was done (a gate cleared) left on `actions` and
   * `history` for the model's first turn to read.
   */
  async #preflight(
    page: Page,
    goal: string,
    startUrl: string,
    destination: string | null,
    allowed: string[],
    actions: AgentAction[],
    history: string[],
  ): Promise<string | null> {
    // A consent gate in front of the page: accept it (the goal cannot be
    // reached through it), and come back to the page the step began on.
    //
    // On a consent URL the gate is checked against the HYDRATED page: measured
    // (be100 PL_06_17), the step began on /en/consent while the page was still
    // a shell, the probe saw no accept control, and the model then spent two
    // of its turns on a wait and a click this rung exists to make free.
    // Polled for the gate itself rather than `networkidle` (2026-08-24): the
    // idle wait held its full 5 s on any page that keeps talking, and even
    // then only re-checked once — this ends the moment the accept control
    // renders, which on the measured page is well under a second.
    const gate = await this.#clearConsentGate(page, goal, startUrl, startUrl, actions, history, 'before the first turn');
    if (gate === 'arrived') {
      return `reached ${page.url()}, the destination the goal names, after clearing a consent gate — no model turn spent`;
    }
    if (destination === null) return null;
    if (atGoalDestination(page.url(), destination)) return null; // nothing to do; the loop's rules decide

    // A link in the tree that points exactly where the goal ends IS the
    // route the goal describes, so it is clicked as written — the one thing
    // the tree says with no judgment involved.
    const nodes = await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
    const link = nodes.find((n: AxNode) => n.role === 'link' && n.url !== '' && n.name !== '' && atGoalDestination(n.url, destination));
    if (link) {
      const decision: AgentDecision = {
        action: 'click',
        selector: withRelaxedRoleName(`role=link[name=${JSON.stringify(link.name)}]`),
        value: '',
        url: '',
        reasoning: `the tree shows a link to ${destination}, the goal's destination`,
      };
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      try {
        await this.#act(page, decision, allowed);
      } catch (caught) {
        ok = false;
        error = describe(caught);
      }
      const record = this.#record(actions.length, decision, page.url(), ok, Date.now() - started, error);
      actions.push(record);
      if (this.#onAction) await this.#onAction(page, record);
      history.push(ok ? `click ${decision.selector} — ok (link to the destination)` : `click ${decision.selector} — FAILED: ${error ?? ''}`);
      if (ok && destinationReached(goal, startUrl, page.url())) {
        return `reached ${page.url()} by the link the tree showed to it — no model turn spent`;
      }
    }

    // A goal that names WHERE but not HOW may be met by going there. One that
    // names a route ("via the sidebar") is about the route, and a goto would
    // pass it without exercising what it describes — so that is left to the
    // model, and the summary says which of the two happened.
    if (!ROUTE_WORDS.test(goal)) {
      const origin = originOf(startUrl);
      if (origin !== null && allowed.includes(origin)) {
        const url = /^https?:/.test(destination) ? destination : `${origin}${destination}`;
        const decision: AgentDecision = {
          action: 'goto',
          selector: '',
          value: '',
          url,
          reasoning: 'the goal names a destination and no route to it; navigated directly',
        };
        const started = Date.now();
        let ok = true;
        let error: string | undefined;
        try {
          await this.#act(page, decision, allowed);
        } catch (caught) {
          ok = false;
          error = describe(caught);
        }
        const record = this.#record(actions.length, decision, page.url(), ok, Date.now() - started, error);
        actions.push(record);
        if (this.#onAction) await this.#onAction(page, record);
        history.push(ok ? `goto ${url} — ok (direct)` : `goto ${url} — FAILED: ${error ?? ''}`);
        if (ok && destinationReached(goal, startUrl, page.url())) {
          return `reached ${page.url()} by direct navigation (the goal named no route) — no model turn spent`;
        }
      }
    }
    return null;
  }

  #result(
    goal: string,
    success: boolean,
    summary: string,
    actions: AgentAction[],
    turns: number,
    startedMs: number,
    inputTokens: number,
    outputTokens: number,
  ): WorkflowResult {
    return {
      goal,
      model: this.model.id,
      success,
      summary,
      actions,
      turns,
      // JSON has no Infinity: an unbounded run records null, and every reader
      // treats null as "no ceiling was set".
      maxSteps: Number.isFinite(this.#maxSteps) ? this.#maxSteps : null,
      latencyMs: Date.now() - startedMs,
      inputTokens,
      outputTokens,
      ...(this.#lookedOnly ? { lookedOnly: true } : {}),
    };
  }

  /**
   * Why a decision should not be acted on as it stands, or null.
   *
   * Three checks, each the structural form of a rule the prompt already
   * states — so a model that follows the prompt never meets them, and a model
   * that does not pays one re-ask instead of a wasted turn:
   * - a selector whose accessible name is in no node of the tree (the tree is
   *   the evidence; a name not in it is a guess that costs 8 s to disprove);
   * - an ok action repeated with nothing changed since (the live PB_03_01
   *   loop: four password fills into a field already filled) — for a
   *   page-changing action; a repeated wait or scroll is told once and then
   *   let through as a turn that advances nothing (IDLE_ACTIONS);
   * - a `finish` while the goal's own destination has not been reached (the
   *   one hole the post-hoc evidence check could not close: it only ran on
   *   failures, so a false finish sailed through as success).
   */
  #refuse(
    decision: AgentDecision,
    axTree: string,
    doneHere: ReadonlySet<string>,
    destination: string | null,
    currentUrl: string,
    ask: number,
    goal: string,
  ): string | null {
    if (decision.action === 'finish') {
      if (destination !== null && !atGoalDestination(currentUrl, destination)) {
        return `the goal ends on ${destination} and the page is on ${currentUrl} — continue toward it, or call fail and say why`;
      }
      return null;
    }
    if (decision.action === 'fail') return null;
    // A delete aimed at "whatever row comes first" is refused before any
    // grounding question: the control exists, and that is the problem.
    const destructive = unscopedDestructiveClick(decision, goal);
    if (destructive !== null) return destructive;
    // `scroll` is in this list (2026-08-25): scrolling to a name the tree
    // does not show waited the full action timeout, three turns running, on
    // every "bring row PL_03_… into view" leg whose row was not rendered.
    if (decision.action === 'click' || decision.action === 'fill' || decision.action === 'hover' || decision.action === 'press' || decision.action === 'scroll') {
      if (decision.selector !== '' && selectorGrounded(decision.selector, axTree) === false) {
        return `"${decision.selector}" names a control that is not in the accessibility tree; take the role and name verbatim from the tree`;
      }
    }
    if (doneHere.has(decisionKey(decision))) {
      const what = `${decision.action} ${decision.selector || decision.url}`;
      if (IDLE_ACTIONS.has(decision.action)) {
        // Looking again is never a stall — but it is never progress either,
        // and the model is told so once. The second ask is let through: the
        // turn it spends counts toward AGENT_NO_PROGRESS_TURNS, which is the
        // honest price of insisting, rather than the run's end.
        return ask === 0
          ? `you already did "${what}" and the tree has not changed since — the tree lists off-screen elements too, so ${decision.action === 'wait' ? 'waiting' : 'scrolling'} again will not reveal more; act on a control the tree shows, or call fail and say what is missing`
          : null;
      }
      return ask === 0
        ? `you already did "${what}" with this value and the page has not changed since — it is done; choose the next part of the goal, or finish`
        : `stalled: repeated "${what}" after being told it was already done`;
    }
    return null;
  }

  async #act(page: Page, decision: AgentDecision, allowed: string[]): Promise<void> {
    switch (decision.action) {
      case 'click':
        if (!decision.selector) throw new Error('click decision carried no selector');
        await this.#target(page, decision.selector);
        await page.locator(decision.selector).first().click({ timeout: this.#actionTimeoutMs });
        break;

      case 'fill': {
        if (!decision.selector) throw new Error('fill decision carried no selector');
        await this.#target(page, decision.selector);
        const field = page.locator(decision.selector).first();
        await field.fill(decision.value, { timeout: this.#actionTimeoutMs });
        // **A fill the framework reverts is the quietest false negative in
        // the loop.** A controlled React input that has not finished
        // hydrating takes the value, then resets it on its next render — the
        // action reports ok, the submit sends an empty field, validation
        // fires, and the run blames the application (the credential path
        // learned this as `fillsLostToHydration`; this is the same fact for
        // every OTHER form the agent drives, e.g. the Create Plan modal).
        // One $0 read-back catches it; one re-fill after a settle fixes it;
        // a field that STILL disagrees throws, so the model is told the
        // truth instead of planning on a value that is not there. Password
        // fields are exempt — they often read back empty by design.
        if (decision.value !== '' && !/password/i.test(decision.selector)) {
          const readBack = await field.inputValue({ timeout: 1_000 }).catch(() => null);
          if (readBack !== null && readBack !== decision.value) {
            await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
            await field.fill(decision.value, { timeout: this.#actionTimeoutMs });
            const second = await field.inputValue({ timeout: 1_000 }).catch(() => null);
            if (second !== null && second !== decision.value) {
              throw new Error(
                `the field did not keep the typed value (holds ${JSON.stringify(second.slice(0, 40))}) — ` +
                  'it may be read-only, masked, or controlled by the page; try another way to set it',
              );
            }
          }
        }
        break;
      }

      case 'press': {
        if (!decision.value) throw new Error('press decision carried no key');
        if (decision.selector) {
          await page
            .locator(decision.selector)
            .first()
            .press(decision.value, { timeout: this.#actionTimeoutMs });
        } else {
          await page.keyboard.press(decision.value);
        }
        break;
      }

      case 'hover':
        if (!decision.selector) throw new Error('hover decision carried no selector');
        await this.#target(page, decision.selector);
        await page
          .locator(decision.selector)
          .first()
          .hover({ timeout: this.#actionTimeoutMs });
        break;

      case 'scroll':
        if (decision.selector) {
          // The attach check first, as for a click: a row a virtualised
          // table has not rendered is "no element matches" in 1.5 s, not a
          // 5 s scrollIntoViewIfNeeded timeout the next turn cannot read.
          await this.#target(page, decision.selector);
          await page
            .locator(decision.selector)
            .first()
            .scrollIntoViewIfNeeded({ timeout: this.#actionTimeoutMs });
        } else {
          // Anonymous function on purpose: esbuild rewrites a *named* one into
          // `__name(fn, …)`, which does not exist in the page. See the note in
          // `engine/evidence.ts`.
          await page.evaluate('window.scrollBy(0, window.innerHeight)');
        }
        break;

      case 'wait': {
        // Event-driven first: the wait ends the moment the network goes
        // quiet. When it was quiet ALREADY — the idle wait returned at once —
        // the model asked for time the network cannot measure (hydration, a
        // menu animating open), and that is paid as one short settle. A flat
        // sleep after every wait was removed 2026-08-24 for taxing settled
        // pages; this taxes only the wait that would otherwise do nothing.
        const started = Date.now();
        await page
          .waitForLoadState('networkidle', { timeout: this.#actionTimeoutMs })
          .catch(() => undefined);
        if (Date.now() - started < 100) await page.waitForTimeout(WAIT_SETTLE_MS).catch(() => undefined);
        break;
      }

      case 'goto': {
        if (!decision.url) throw new Error('goto decision carried no url');
        const target = originOf(decision.url);
        if (target === null || !allowed.includes(target)) {
          throw new Error(
            `refusing to navigate off-origin to ${decision.url} (allowed: ${allowed.join(', ') || 'none'})`,
          );
        }
        await page.goto(decision.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.#actionTimeoutMs,
        });
        break;
      }

      case 'dbCount': {
        if (!decision.selector) throw new Error('dbCount decision carried no table (name it in selector)');
        if (this.#dbProbe === null) {
          throw new Error(
            'no database is configured for this run — do not retry dbCount; verify through the page instead',
          );
        }
        // The observed number rides the history line as the action's note —
        // the model reasons from what the database actually said, and the
        // record shows the evidence, never just the claim.
        const count = await this.#dbProbe(decision.selector, parseWherePairs(decision.value));
        this.#lastTargetNote = `observed ${count} row(s)`;
        break;
      }

      default:
        throw new Error(`unhandled agent action: ${decision.action}`);
    }

    // Interstitials frequently need a beat to settle before the next observation.
    await page.waitForLoadState('domcontentloaded', { timeout: this.#actionTimeoutMs }).catch(() => undefined);
  }

  /**
   * Fail fast, and specifically, when a selector matches nothing.
   *
   * A click on a selector that resolves to nothing waits the full action
   * timeout (8 s) to say "not found" — and the model's wrong guesses are the
   * ordinary case, not the exception. Waiting one short window for the
   * element to ATTACH, and naming the count, turns that into a 1.5 s answer
   * the next turn can act on: "no element matches" is a different fact from
   * "found, could not be clicked", and "4 matched, acted on the first" is the
   * hint to narrow with >> nth=N.
   */
  async #target(page: Page, selector: string): Promise<void> {
    const locator = page.locator(selector);
    try {
      await locator.first().waitFor({ state: 'attached', timeout: TARGET_ATTACH_MS });
    } catch {
      throw new Error(`no element matches "${selector}" (waited ${TARGET_ATTACH_MS} ms)`);
    }
    const count = await locator.count().catch(() => 1);
    if (count > 1) this.#lastTargetNote = `${count} matched, acted on the first`;
  }

  /** Set by `#target` for the history line of the action that follows. */
  #lastTargetNote: string | null = null;
  /**
   * Set when the loop ended because every action taken was a look — see the
   * no-progress judge. Reset at the top of `run()`; read into the RESULT
   * (`WorkflowResult.lookedOnly`), never off the instance directly, because
   * one agent instance answers many workflow steps across a run.
   */
  #lookedOnly = false;
  /** This run's read-only DB access, when the runner provided one. */
  #dbProbe: AgentDbProbe | null = null;

  #record(
    index: number,
    decision: AgentDecision,
    url: string,
    ok: boolean,
    durationMs: number,
    error?: string,
  ): AgentAction {
    return {
      index,
      action: decision.action,
      selector: decision.selector === '' ? null : decision.selector,
      value: decision.value === '' ? null : decision.value,
      url,
      reasoning: decision.reasoning,
      ok,
      error,
      durationMs,
    };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
