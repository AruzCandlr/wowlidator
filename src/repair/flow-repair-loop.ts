/**
 * Run a flow; on failure, ask a `FlowRepairModel` for a targeted fix, write
 * it out as a new, reviewable flow file (never overwriting the original),
 * and retry — up to `maxAttempts` total runs. Reports `dead-end` rather than
 * throwing once attempts are exhausted, matching `runFlow`'s own "a failing
 * step is recorded, not thrown" contract, one level up.
 *
 * "Generated modifications should never silently overwrite source files" —
 * every attempt beyond the first lands as its own `.flow.json` (a complete,
 * directly-runnable file) plus a human-readable `.patch` describing exactly
 * what changed and why, never a rewrite of the file you started with.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureAxTree } from '../healer/jit-healer.js';
import { runFlow, withPage, type Flow, type FlowStep, type RunFlowOptions } from '../engine/runner.js';
import type { ProofBundle, ProofStep } from '../engine/proof-bundle.js';
import type { AgentRecord } from '../engine/proof-bundle.js';
import type { WorkflowAgent } from '../orchestrator/workflow-agent.js';
import type { FlowRepairModel, RepairInvestigation, RepairProposal } from './flow-repair-model.js';

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
export const DEFAULT_REPAIR_MAX_AX_NODES = 150;

export interface FlowRepairLoopOptions {
  model: FlowRepairModel;
  /** Total attempts, including the first, unmodified run. Default 3. */
  maxAttempts?: number | undefined;
  /** Directory reviewable `.flow.json` / `.patch` files are written to. */
  outDir: string;
  /** Passed straight through to every `runFlow` call. */
  runOptions?: Omit<RunFlowOptions, 'generatedBy'> | undefined;
  /** AX-tree node budget for the page re-visited to gather repair context. */
  maxAxNodes?: number | undefined;
  /** Called at each attempt-loop lifecycle event — for live progress output. */
  onLog?: ((line: string) => void) | undefined;
  /**
   * Reinvestigate each failure live before asking for a fix: the agent goes
   * back to the page where the step failed and tries to reach the state the
   * step needed — opening menus, waiting, scrolling — and both its findings
   * and the AX tree of the page *it opened up* go into the repair request.
   * Opt-in for the same reason as `--agent-assist`: the agent acts on the
   * application, and that is a decision about someone's system, not a default.
   *
   * Unlike the ladder's agent rung, an assertion failure IS investigated here:
   * nothing the agent does can make the flow pass — the repaired flow re-runs
   * from scratch on its own — so the "a claim it made true proves nothing"
   * hazard does not arise. Its actions are evidence, never a result.
   */
  agent?: WorkflowAgent | null | undefined;
  /**
   * Let the model regenerate the flow from the failed step onward — replacing
   * the failed step AND every step after it in the same section — instead of
   * only patching the one step. For when the failure shows the whole tail was
   * written against a page that does not exist. Enforced structurally: with
   * this off the model is never shown the following steps and any tail it
   * returns anyway is discarded.
   */
  regenerateFrom?: boolean | undefined;
}

export interface RepairFileRecord {
  reasoning: string;
  flowPath: string;
  patchPath: string;
}

export interface RepairAttempt {
  attempt: number;
  flow: Flow;
  bundle: ProofBundle;
  /** Set when a repair was generated and applied for the *next* attempt. */
  repair?: RepairFileRecord | undefined;
  /** Set when an agent reinvestigated this attempt's failure live. */
  investigation?: AgentRecord | undefined;
}

export interface FlowRepairOutcome {
  status: 'passed' | 'dead-end';
  attempts: RepairAttempt[];
  /** The flow that finally passed, or the last one attempted if dead-ended. */
  finalFlow: Flow;
}

export interface FailureLocation {
  section: 'setup' | 'steps';
  index: number;
}

/**
 * The first failed step, and where it lives in `flow`. Teardown failures are
 * not repaired here — teardown exists to clean up regardless of the body's
 * outcome, and rewriting it doesn't change whether the flow's actual goal
 * was reached.
 *
 * Correct by construction, not by re-deriving indices: `setup` and `steps`
 * each execute strictly in order and stop at the first failure, so the first
 * `setup.length` bundle entries are exactly the setup attempts (however many
 * of them ran before stopping), and — only if every one of those passed —
 * the entries after that are exactly the `steps` attempts.
 */
function locateFailedStep(flow: Flow, bundle: ProofBundle): FailureLocation | null {
  const setupLen = flow.setup?.length ?? 0;
  for (let i = 0; i < setupLen; i++) {
    if (bundle.steps[i]?.status !== 'passed') return { section: 'setup', index: i };
  }
  const stepsLen = flow.steps.length;
  for (let i = 0; i < stepsLen; i++) {
    if (bundle.steps[setupLen + i]?.status !== 'passed') return { section: 'steps', index: i };
  }
  return null;
}

function describeFailure(step: ProofStep | undefined): string {
  if (!step) return 'unknown failure';
  return step.error ?? `${step.action} failed`;
}

/**
 * Splice a proposal into the failing section. A non-empty `rewriteFollowing`
 * replaces the failed step *and everything after it in that section* — the
 * "regenerate from the failed step" case — otherwise only the one step moves.
 * Exported for the pure tier of `tests/flow-repair.test.ts`; the loop is the
 * only production caller.
 */
export function applyRepair(flow: Flow, location: FailureLocation, proposal: RepairProposal): Flow {
  const target = [...(location.section === 'setup' ? (flow.setup ?? []) : flow.steps)];
  const rewriteFollowing = proposal.rewriteFollowing ?? [];
  const removed = rewriteFollowing.length > 0 ? target.length - location.index : 1;
  target.splice(location.index, removed, ...proposal.insertBefore, proposal.replacement, ...rewriteFollowing);
  return location.section === 'setup' ? { ...flow, setup: target } : { ...flow, steps: target };
}

/**
 * The goal handed to the reinvestigating agent. Same contract as the ladder's
 * `#agentRescue` goal — prepare and observe, never perform — because whatever
 * the agent does here is *evidence for a repair proposal*, and a repair that
 * only works because an agent did the step for it would be repaired wrong.
 */
export function buildInvestigationGoal(failedStep: FlowStep, error: string): string {
  const intent = 'intent' in failedStep && failedStep.intent ? ` (${failedStep.intent})` : '';
  return (
    `A test step just failed on this page and you are investigating why. ` +
    `The step${intent}: ${JSON.stringify(failedStep)}. ` +
    `It failed with: ${error}.\n` +
    `Get the page into the state where that step would have worked — open the menu, tab or ` +
    `disclosure its target lives behind, scroll it into view, or wait for the view to finish ` +
    `loading — then call finish and describe what you found. Do NOT perform the failed step ` +
    `itself: do not click its target, do not type its value, do not assert anything. If the ` +
    `target genuinely does not exist anywhere, call fail and say what the page offers instead.`
  );
}

function formatPatch(params: {
  attempt: number;
  location: FailureLocation;
  failedStep: FlowStep;
  replacedFollowing: FlowStep[];
  error: string;
  proposal: RepairProposal;
  investigation: RepairInvestigation | undefined;
}): string {
  const { attempt, location, failedStep, replacedFollowing, error, proposal, investigation } = params;
  const lines = [
    `# Flow repair — attempt ${attempt}`,
    '',
    '## Why the previous attempt failed',
    error,
  ];
  if (investigation) {
    lines.push(
      '',
      `## Agent reinvestigation (${investigation.succeeded ? 'reached its goal' : 'did not reach its goal'})`,
      investigation.summary,
    );
    for (const action of investigation.actions) lines.push(`  - ${action}`);
  }
  lines.push('', '## Model reasoning', proposal.reasoning, '', `## Change at ${location.section}[${location.index}]`);
  if (proposal.insertBefore.length > 0) {
    lines.push('', 'Inserted before:');
    proposal.insertBefore.forEach((step, i) => lines.push(`  ${i + 1}. ${JSON.stringify(step)}`));
  }
  lines.push('', 'Replaced:', `  was: ${JSON.stringify(failedStep)}`, `  now: ${JSON.stringify(proposal.replacement)}`);
  const rewriteFollowing = proposal.rewriteFollowing ?? [];
  if (rewriteFollowing.length > 0) {
    lines.push('', `Regenerated from the failed step onward (${location.section}[${location.index + 1}…]):`);
    lines.push('  was:');
    replacedFollowing.forEach((step, i) => lines.push(`    ${i + 1}. ${JSON.stringify(step)}`));
    lines.push('  now:');
    rewriteFollowing.forEach((step, i) => lines.push(`    ${i + 1}. ${JSON.stringify(step)}`));
  }
  return `${lines.join('\n')}\n`;
}

/** One reviewable line per agent action, mirroring the agent's own history format. */
function investigationOf(record: AgentRecord): RepairInvestigation {
  return {
    summary: record.summary,
    succeeded: record.success,
    actions: record.actions.map((a) => {
      const target = a.selector ?? a.url ?? '';
      return a.ok
        ? `${a.action} ${target} — ok`
        : `${a.action} ${target} — FAILED: ${a.error ?? ''}`;
    }),
  };
}

export class FlowRepairLoop {
  readonly #model: FlowRepairModel;
  readonly #maxAttempts: number;
  readonly #outDir: string;
  readonly #runOptions: Omit<RunFlowOptions, 'generatedBy'>;
  readonly #maxAxNodes: number;
  readonly #onLog: ((line: string) => void) | undefined;
  readonly #agent: WorkflowAgent | null;
  readonly #regenerateFrom: boolean;

  constructor(options: FlowRepairLoopOptions) {
    this.#model = options.model;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS);
    this.#outDir = options.outDir;
    this.#runOptions = options.runOptions ?? {};
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_REPAIR_MAX_AX_NODES;
    this.#onLog = options.onLog;
    this.#agent = options.agent ?? null;
    this.#regenerateFrom = options.regenerateFrom ?? false;
  }

  /**
   * `baseName` seeds the reviewable file names — pass something derived from
   * the original flow file (e.g. its filename without extension).
   */
  async run(flow: Flow, baseName: string): Promise<FlowRepairOutcome> {
    const attempts: RepairAttempt[] = [];
    const history: Array<{ attempt: number; summary: string; outcome: string }> = [];
    let current = flow;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      this.#onLog?.(`\n— attempt ${attempt}/${this.#maxAttempts} —`);
      const bundle = await runFlow(current, this.#runOptions);
      const record: RepairAttempt = { attempt, flow: current, bundle };
      attempts.push(record);

      if (bundle.status === 'passed') {
        this.#onLog?.(`✓ passed`);
        return { status: 'passed', attempts, finalFlow: current };
      }

      if (attempt === this.#maxAttempts) {
        this.#onLog?.(`✗ failed — out of attempts`);
        break; // exhausted — no point asking for one more fix
      }

      const location = locateFailedStep(current, bundle);
      if (!location) {
        this.#onLog?.(`✗ failed outside setup/steps — nothing here for a repair to target`);
        break; // not a repairable section (teardown, or a run-level connect error)
      }

      const sourceArray = location.section === 'setup' ? current.setup : current.steps;
      const failedStep = sourceArray?.[location.index];
      if (!failedStep) break; // defensive — locateFailedStep's bounds should make this unreachable

      const setupLen = current.setup?.length ?? 0;
      const recordedIndex = (location.section === 'setup' ? 0 : setupLen) + location.index;
      const failedRecord = bundle.steps[recordedIndex];
      const error = describeFailure(failedRecord);
      const url = failedRecord?.url ?? current.baseUrl ?? '';
      this.#onLog?.(`✗ failed at ${location.section}[${location.index}]: ${error}`);

      let axTree = '(page unavailable for a fresh accessibility-tree read)';
      let agentRecord: AgentRecord | undefined;
      if (url) {
        try {
          const revisit = await withPage(this.#runOptions.cdpUrl, async (page) => {
            await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
            let investigated: AgentRecord | undefined;
            if (this.#agent) {
              this.#onLog?.(`  agent reinvestigating the failed step live…`);
              // `run` never throws — a failed investigation is itself evidence.
              investigated = await this.#agent.run(page, buildInvestigationGoal(failedStep, error));
            }
            // Captured AFTER the investigation, deliberately: the tree of the
            // page as the agent left it — menu open, view hydrated — is the
            // one that contains the answer the moment-of-failure tree lacked.
            const tree = await captureAxTree(page, this.#maxAxNodes);
            return { tree, investigated };
          });
          axTree = revisit.tree;
          agentRecord = revisit.investigated;
        } catch {
          // Best-effort — a repair proposal without a fresh AX tree is still better than none.
        }
      }

      const investigation = agentRecord ? investigationOf(agentRecord) : undefined;
      if (agentRecord) {
        record.investigation = agentRecord;
        this.#onLog?.(
          `  agent ${agentRecord.success ? 'reached the failure state' : 'could not reach the failure state'}: ${agentRecord.summary}`,
        );
      }

      // The permission to regenerate the tail travels as data: no
      // `followingSteps`, no tail in the prompt, no tail in the proposal.
      const followingSteps = this.#regenerateFrom
        ? (sourceArray ?? []).slice(location.index + 1)
        : undefined;

      this.#onLog?.(`  asking the generator role for a fix…`);
      const proposal = await this.#model.repair({
        flow: current,
        failedStep,
        section: location.section,
        index: location.index,
        error,
        axTree,
        url,
        attempt,
        history,
        investigation,
        followingSteps,
      });
      // Structural enforcement, belt and braces over the model-side guard: a
      // backend that returns a tail nobody offered it does not get one applied.
      if (!this.#regenerateFrom) proposal.rewriteFollowing = [];

      if (!proposal.canFix) {
        this.#onLog?.(`  model declined: ${proposal.reasoning}`);
        history.push({ attempt, summary: 'model declined to propose a fix', outcome: proposal.reasoning });
        break;
      }
      this.#onLog?.(`  got a fix: ${proposal.reasoning}`);
      const rewriteFollowing = proposal.rewriteFollowing ?? [];
      if (rewriteFollowing.length > 0) {
        this.#onLog?.(
          `  regenerating the flow from the failed step onward — ${rewriteFollowing.length} following step(s) rewritten`,
        );
      }

      const revised = applyRepair(current, location, proposal);
      const nextAttempt = attempt + 1;
      const flowPath = join(this.#outDir, `${baseName}.attempt-${nextAttempt}.flow.json`);
      const patchPath = join(this.#outDir, `${baseName}.attempt-${nextAttempt}.patch`);
      await mkdir(this.#outDir, { recursive: true });
      await writeFile(flowPath, `${JSON.stringify(revised, null, 2)}\n`, 'utf8');
      await writeFile(
        patchPath,
        formatPatch({
          attempt: nextAttempt,
          location,
          failedStep,
          replacedFollowing: (sourceArray ?? []).slice(location.index + 1),
          error,
          proposal,
          investigation,
        }),
        'utf8',
      );
      this.#onLog?.(`  wrote ${flowPath} — retrying`);

      record.repair = { reasoning: proposal.reasoning, flowPath, patchPath };
      history.push({ attempt, summary: proposal.reasoning, outcome: 'retrying with this fix' });
      current = revised;
    }

    return { status: 'dead-end', attempts, finalFlow: current };
  }
}
