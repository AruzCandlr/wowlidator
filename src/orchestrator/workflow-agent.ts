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

import { SELECTOR_SYNTAX_RULES, captureAxTree } from '../healer/jit-healer.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import type { AgentAction, AgentRecord } from '../engine/proof-bundle.js';

export const DEFAULT_AGENT_MAX_STEPS = 8;
export const DEFAULT_AGENT_MAX_NODES = 90;
/** Per-action timeout while the agent holds the browser. */
export const DEFAULT_AGENT_ACTION_TIMEOUT_MS = 8_000;

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
  'finish',
  'fail',
] as const;
export type AgentActionKind = (typeof AGENT_ACTIONS)[number];

const DecisionSchema = lenientObject({
  action: z.enum(AGENT_ACTIONS),
  selector: z
    .string()
    .describe(
      'Playwright selector for click/fill/press/hover, or the element to scroll into view. Empty otherwise.',
    ),
  value: z
    .string()
    .describe('Text for fill, key name for press (Enter, Escape, Tab, ArrowDown). Empty otherwise.'),
  url: z.string().describe('Absolute URL for goto. Empty otherwise.'),
  reasoning: z.string().describe('One sentence: why this action moves toward the goal.'),
});

export interface AgentObservation {
  goal: string;
  url: string;
  axTree: string;
  /** What has been tried so far, and how it went. */
  history: string[];
  stepsRemaining: number;
}

export interface AgentDecision {
  action: AgentActionKind;
  selector: string;
  value: string;
  url: string;
  reasoning: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

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
           empty to scroll down one screen. Use when the tree shows a control
           the page has not rendered into view yet.
- wait   — let the page settle for a moment and look again. Use when the tree
           looks half-built, or right after an action that starts a load.
- goto   — navigate directly. Absolute URL in "url".
- finish — the goal is met. Explain how you know in "reasoning".
- fail   — the goal cannot be reached from here. Explain why.

${SELECTOR_SYNTAX_RULES}

Rules:
- Do not repeat an action that already failed — read the history and try a different route.
- Do not take destructive actions: no delete, no purchase, no irreversible submit, unless the goal explicitly asks for it.
- Call finish as soon as the goal is satisfied. Do not keep exploring.
- If the tree shows you are already where the goal describes, call finish immediately.`;

function buildUserPrompt(observation: AgentObservation): string {
  const lines = [
    `GOAL: ${observation.goal}`,
    '',
    `Current URL: ${observation.url}`,
    `Actions remaining: ${observation.stepsRemaining}`,
  ];
  if (observation.history.length > 0) {
    lines.push('', 'What you have tried:');
    for (const entry of observation.history) lines.push(`  - ${entry}`);
  }
  lines.push('', 'Accessibility tree:', observation.axTree);
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
      inputTokens,
      outputTokens,
    };
  }
}

export interface WorkflowAgentOptions {
  model: AgentModel;
  /** Hard ceiling on model turns. The agent fails rather than looping forever. */
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
}

export interface WorkflowResult extends AgentRecord {}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class WorkflowAgent {
  readonly model: AgentModel;

  readonly #maxSteps: number;
  readonly #maxAxNodes: number;
  readonly #actionTimeoutMs: number;
  readonly #allowedOrigins: string[] | undefined;
  readonly #onAction: ((page: Page, action: AgentAction) => Promise<void>) | undefined;

  constructor(options: WorkflowAgentOptions) {
    this.model = options.model;
    this.#maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_AGENT_MAX_NODES;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_AGENT_ACTION_TIMEOUT_MS;
    this.#allowedOrigins = options.allowedOrigins;
    this.#onAction = options.onAction;
  }

  /**
   * Drive `page` until `goal` is met or the budget runs out. Always resolves —
   * failure is reported in the record, never thrown, so the run can continue
   * and the report can show what the agent tried.
   */
  async run(page: Page, goal: string): Promise<WorkflowResult> {
    const startedMs = Date.now();
    const actions: AgentAction[] = [];
    const history: string[] = [];
    const allowed = this.#allowedOrigins ?? [originOf(page.url())].filter((o): o is string => !!o);

    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let success = false;
    let summary = `agent gave up after ${this.#maxSteps} turns without reaching the goal`;

    while (turns < this.#maxSteps) {
      turns += 1;

      const axTree = await captureAxTree(page, this.#maxAxNodes);
      let decision: AgentDecision;
      try {
        decision = await this.model.decide({
          goal,
          url: page.url(),
          axTree,
          // Snapshot: the agent keeps mutating `history`, and an observation
          // handed to the model must not change under it after the fact.
          history: [...history],
          stepsRemaining: this.#maxSteps - turns,
        });
      } catch (error) {
        summary = `agent model failed: ${describe(error)}`;
        break;
      }

      inputTokens += decision.inputTokens ?? 0;
      outputTokens += decision.outputTokens ?? 0;

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

      const actionStarted = Date.now();
      let ok = true;
      let error: string | undefined;

      try {
        await this.#act(page, decision, allowed);
      } catch (caught) {
        ok = false;
        error = describe(caught);
      }

      const record = this.#record(
        actions.length,
        decision,
        page.url(),
        ok,
        Date.now() - actionStarted,
        error,
      );
      actions.push(record);
      history.push(
        ok
          ? `${decision.action} ${decision.selector || decision.url} — ok, now at ${page.url()}`
          : `${decision.action} ${decision.selector || decision.url} — FAILED: ${error ?? ''}`,
      );

      if (this.#onAction) await this.#onAction(page, record);
    }

    return {
      goal,
      model: this.model.id,
      success,
      summary,
      actions,
      turns,
      maxSteps: this.#maxSteps,
      latencyMs: Date.now() - startedMs,
      inputTokens,
      outputTokens,
    };
  }

  async #act(page: Page, decision: AgentDecision, allowed: string[]): Promise<void> {
    switch (decision.action) {
      case 'click':
        if (!decision.selector) throw new Error('click decision carried no selector');
        await page.locator(decision.selector).first().click({ timeout: this.#actionTimeoutMs });
        break;

      case 'fill':
        if (!decision.selector) throw new Error('fill decision carried no selector');
        await page
          .locator(decision.selector)
          .first()
          .fill(decision.value, { timeout: this.#actionTimeoutMs });
        break;

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
        await page
          .locator(decision.selector)
          .first()
          .hover({ timeout: this.#actionTimeoutMs });
        break;

      case 'scroll':
        if (decision.selector) {
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

      case 'wait':
        await page
          .waitForLoadState('networkidle', { timeout: this.#actionTimeoutMs })
          .catch(() => undefined);
        await page.waitForTimeout(400);
        break;

      case 'goto': {
        if (!decision.url) throw new Error('goto decision carried no url');
        const target = originOf(decision.url);
        if (allowed.length > 0 && (target === null || !allowed.includes(target))) {
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

      default:
        throw new Error(`unhandled agent action: ${decision.action}`);
    }

    // Interstitials frequently need a beat to settle before the next observation.
    await page.waitForLoadState('domcontentloaded', { timeout: this.#actionTimeoutMs }).catch(() => undefined);
  }

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
