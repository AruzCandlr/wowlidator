/**
 * Suite-wide memory of repairs that worked, so a big catalog against one
 * application stops paying for the same fix once per case.
 *
 * The live run that forced this (be100.csv, 2026-08-25): every one of 108
 * cases authored the same sign-in into its setup, every one hit the same
 * dead-click hydration race on the "Next" button, and every one burned
 * 6–13s plus healer and repair model calls rediscovering the same fix —
 * insert a second "Next" click before the password fill. The repair loop
 * got each case through; nothing carried the lesson to the next case.
 *
 * The contract, in the healed-selector cache's tradition applied one level
 * up: a repair is remembered only after the re-run proved it — the repaired
 * step itself passed on the next attempt (`FlowRepairLoop` checks the
 * bundle, not the proposal) — and is then pre-applied to later flows
 * *before their first attempt*, so the fix costs $0 from then on. A
 * pre-applied fix that no longer works simply fails like any step and goes
 * through repair again; memory can waste one splice, never a verdict.
 *
 * What is deliberately NOT remembered:
 * - `rewriteFollowing` proposals — a regenerated tail is written against one
 *   case's goal and grafting it onto another case would rewrite what that
 *   case tests.
 * - Steps with no selector/url identity (`workflow`, `when`, `use`) — their
 *   meaning lives in a goal or a branch, not an addressable target.
 *
 * Matching is scoped by page path: a remembered fix applies only to a step
 * the flow reaches on the same path the failure happened on, tracked
 * through the flow's own `goto`s. A step after an in-page navigation the
 * tracker cannot see just misses the memory and runs normally — the
 * conservative miss, never a misfire on a same-shaped selector elsewhere.
 *
 * In-memory and per-suite-invocation on purpose: catalog plans are authored
 * fresh each run, and a structural edit persisted across runs would outlive
 * the page it was learned on with nothing re-proving it.
 */

import type { Flow, FlowStep } from '../engine/runner.js';
import type { RepairProposal } from './flow-repair-model.js';

interface RememberedRepair {
  /** Path of the page the failure happened on, e.g. `/en/login`. */
  path: string;
  failedStep: FlowStep;
  /**
   * The step just before the failure in the flow that FAILED. This is what
   * lets adapt() tell the broken shape from the fixed one when they overlap:
   * the be100 login already had a "Next" click before the password fill and
   * the fix inserted a second — so "the insert appears right before the
   * step" describes the broken flow too, and only `precededBy + insertBefore`
   * describes the fixed one.
   */
  precededBy: FlowStep | null;
  insertBefore: FlowStep[];
  replacement: FlowStep;
  reasoning: string;
  /** The case the fix was learned from, for the log line. */
  learnedFrom: string;
}

/** Fields that identify a step's target; `intent` is prose and never identity. */
function stepKeyOf(step: FlowStep): string | null {
  const s = step as Record<string, unknown>;
  const target = s.selector ?? s.url ?? s.key;
  if (typeof target !== 'string' || target === '') return null;
  return `${step.action} :: ${target}`;
}

/** The path component of a flow's `goto` target, absolute or relative. */
export function pathOf(url: string): string | null {
  try {
    return new URL(url, 'http://relative.invalid').pathname;
  } catch {
    return null;
  }
}

/** JSON equality with `intent` (documentation, not behaviour) ignored. */
function sameStep(a: FlowStep, b: FlowStep): boolean {
  const strip = (step: FlowStep) => {
    const { intent: _intent, ...rest } = step as Record<string, unknown> & { intent?: unknown };
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * The remembered replacement, re-fitted to the step actually in this flow:
 * only the fields the repair *changed* are carried over, so a later case's
 * own value and intent survive a repair that never touched them. A repair
 * that changed the action is a different step entirely and is used verbatim.
 */
export function refitReplacement(
  remembered: { failedStep: FlowStep; replacement: FlowStep },
  current: FlowStep,
): FlowStep {
  const { failedStep, replacement } = remembered;
  if (failedStep.action !== replacement.action) return replacement;
  const failed = failedStep as Record<string, unknown>;
  const repl = replacement as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(failed), ...Object.keys(repl)])) {
    if (JSON.stringify(failed[key]) === JSON.stringify(repl[key])) continue; // untouched by the repair
    if (key in repl) out[key] = repl[key];
    else delete out[key];
  }
  return out as unknown as FlowStep;
}

export class RepairMemory {
  /** First proven fix wins — the common case is 107 identical rediscoveries. */
  readonly #fixes = new Map<string, RememberedRepair>();

  get size(): number {
    return this.#fixes.size;
  }

  /**
   * Remember a proven fix. Returns true when stored, false when refused
   * (tail rewrite, unkeyable step, or a fix for this step already known).
   */
  record(params: {
    url: string;
    failedStep: FlowStep;
    /** The step just before the failure in the failing flow, if any. */
    precededBy: FlowStep | null;
    proposal: RepairProposal;
    learnedFrom: string;
  }): boolean {
    const { url, failedStep, precededBy, proposal, learnedFrom } = params;
    if ((proposal.rewriteFollowing ?? []).length > 0) return false;
    const stepKey = stepKeyOf(failedStep);
    const path = pathOf(url);
    if (stepKey === null || path === null) return false;
    const key = `${path} :: ${stepKey}`;
    if (this.#fixes.has(key)) return false;
    this.#fixes.set(key, {
      path,
      failedStep,
      precededBy,
      insertBefore: proposal.insertBefore,
      replacement: proposal.replacement,
      reasoning: proposal.reasoning,
      learnedFrom,
    });
    return true;
  }

  /**
   * Pre-apply every remembered fix this flow's steps match, returning the
   * adapted flow (the input is never mutated) and one human-readable note
   * per application for the run log. Path context flows from `setup` into
   * `steps` — they execute as one sequence.
   */
  adapt(flow: Flow): { flow: Flow; applied: string[] } {
    if (this.#fixes.size === 0) return { flow, applied: [] };
    const applied: string[] = [];
    let path: string | null = null;

    const adaptSection = (steps: readonly FlowStep[]): FlowStep[] => {
      const out: FlowStep[] = [];
      for (const step of steps) {
        if (step.action === 'goto') path = pathOf(step.url) ?? path;
        const stepKey = stepKeyOf(step);
        const fix = path !== null && stepKey !== null ? this.#fixes.get(`${path} :: ${stepKey}`) : undefined;
        if (!fix) {
          out.push(step);
          continue;
        }
        // Applied already? Only when the steps behind us read as the FIXED
        // shape — the failure's own predecessor followed by the insert. The
        // insert alone is not enough: see `RememberedRepair.precededBy`.
        const fixedTail = [...(fix.precededBy === null ? [] : [fix.precededBy]), ...fix.insertBefore];
        const alreadyThere =
          fix.insertBefore.length > 0 &&
          fixedTail.length <= out.length &&
          fixedTail.every((s, i) => sameStep(s, out[out.length - fixedTail.length + i]!));
        const inserting = fix.insertBefore.length > 0 && !alreadyThere;
        const refit = refitReplacement(fix, step);
        const rewriting = !sameStep(refit, step);
        if (!inserting && !rewriting) {
          out.push(step); // the flow already carries this fix — nothing to do
          continue;
        }
        if (inserting) out.push(...fix.insertBefore);
        out.push(refit);
        const how = [
          ...(inserting ? [`${fix.insertBefore.length} step(s) inserted before it`] : []),
          ...(rewriting ? ['step rewritten'] : []),
        ].join(', ');
        applied.push(
          `${stepKey} on ${fix.path} — ${how} (learned from "${fix.learnedFrom}": ${fix.reasoning})`,
        );
      }
      return out;
    };

    const setup = flow.setup === undefined ? undefined : adaptSection(flow.setup);
    const steps = adaptSection(flow.steps);
    if (applied.length === 0) return { flow, applied };
    return { flow: { ...flow, ...(setup === undefined ? {} : { setup }), steps }, applied };
  }
}
