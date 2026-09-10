/**
 * Action authority — what may change the application, and on whose word.
 *
 * Phase B of docs/research/commerce-agents-patterns.md (2026-09-05). The loop
 * already refused an unscoped destructive click and an off-origin goto; what
 * it did not have was **observed provenance** (an identifier in the goal is
 * not proof that this session ever saw the row, or still sees it) and a
 * **host-supplied mutation policy** (which categories a batch may perform,
 * and which irreversible ones need an approval the goal text cannot
 * manufacture). Both live here, pure, so they are tested without a browser.
 *
 * Three rules, applied in this order by `gateMutation` before ANY browser
 * mutation of a governed category:
 *  1. capability — the policy's `deny` list wins; an `allow` list, when
 *     present, is exhaustive;
 *  2. provenance — for an irreversible category, every identifier the
 *     selector scopes to must have been observed in this session AND be in
 *     the latest snapshot the harness captured (`TargetProvenance`, fed only
 *     from accessibility captures — never from goal text, model output or the
 *     selector itself);
 *  3. approval — an irreversible action needs a pre-approved manifest entry
 *     (`policy.approved`) or the host's explicit `approve` hook to say yes.
 *
 * With no policy configured, capability is unrestricted but approval is not:
 * an irreversible action still needs the host's explicit approval hook. Goal
 * text and model output can never manufacture approval.
 *
 * **A destructive flow has two halves, and they are gated separately**
 * (2026-09-08). Before this, the category was read off the clicked control's
 * name alone, which got the pair exactly backwards: a row's `ลบ` icon — which
 * in humi only calls `setDeleteTarget(rule)` and raises a dialog — was
 * classified `delete` and held, while the `ยืนยัน` button INSIDE that dialog,
 * the click that actually destroys the row, matched `SUBMIT_NAME` and was
 * waved through as reversible. So the harness held the harmless half and
 * guarded nothing on the half that counts.
 *
 * `MutationPhase` names the halves. A control inside an open dialog is a
 * `commit`; anything else is an `open`. A confirming control inside a dialog
 * whose own text is destructive inherits that destructive category instead of
 * `submit`, which is what closes the hole. An approval may be scoped to one
 * phase (`{ category: 'delete', phase: 'open' }`), so a run whose cases only
 * ever raise a confirmation and cancel it — 56 of the 447 rows in one BE
 * catalog — can proceed while every commit still stops dead. An approval that
 * names no phase means both, as it always did.
 */

import type {
  BlockedOutcome,
  MutationCategory,
  MutationPhase,
  ProvenanceFacts,
} from '../engine/proof-bundle.js';
import type { AxNode } from '../healer/jit-healer.js';
import { DESTRUCTIVE_NAME, goalIdentifiers, selectorCarries, targetName, type DecisionLike } from './agent-guards.js';
import { z } from 'zod';

export const MUTATION_CATEGORIES = ['submit', 'delete', 'approve'] as const satisfies readonly MutationCategory[];

/** The categories that cannot be undone on an authoritative database — the ones provenance and approval gate. */
export const IRREVERSIBLE_CATEGORIES: ReadonlySet<MutationCategory> = new Set(['delete', 'approve']);

/** A manifest entry: "this category may run, on this target (or any)". */
export interface ApprovedMutation {
  readonly category: MutationCategory;
  /** The identifier the approval is for; `*` or absent means any target in the category. */
  readonly target?: string | undefined;
  /**
   * Which half of the flow this approves. Absent means both, which is what
   * every entry written before phases existed meant. `open` is the useful
   * narrowing: it lets a case raise a delete confirmation and cancel it,
   * while the commit inside that dialog still needs its own yes.
   */
  readonly phase?: MutationPhase | undefined;
}

/**
 * The host's manifest for a run. Serialisable on purpose: a SIT batch supplies
 * it once (`WOWLIDATOR_MUTATION_POLICY`, a panel form, an MCP argument) and
 * never sees a modal per case.
 */
export interface MutationPolicy {
  /** When present, the ONLY categories that may run. */
  readonly allow?: readonly MutationCategory[] | undefined;
  /** Categories that never run. Wins over `allow`. */
  readonly deny?: readonly MutationCategory[] | undefined;
  /** Pre-approved irreversible actions. */
  readonly approved?: readonly ApprovedMutation[] | undefined;
  /**
   * The run's standing undo, when it has one (2026-09-09).
   *
   * The approval gate asks "did someone say yes to this?", and until now that
   * was the only question — a delete on a run that had snapshotted the very
   * tables it writes to was held exactly as hard as one on a run with no
   * safety net at all. Live, be-high-ctx PL_09_01: the case exists to prove
   * the Delete control opens its confirmation, and it ended `ERROR:
   * approval-missing` having asked the application nothing.
   *
   * A verified restore is a different answer to the same question. It is not
   * "someone approved this"; it is "this cannot outlive the run".
   *
   * **It is never inferred.** The runner sets this only where the baseline was
   * actually taken, a write credential actually resolved, and at least one
   * table came back `restorable` — the same three facts `db restore` itself
   * requires. A snapshot with no credential (the common misconfiguration, and
   * this machine's own state until today) leaves it absent, and the gate holds
   * as it always did.
   */
  readonly reversible?: MutationReversibility | undefined;
  /** Where the policy came from, for the record (`env`, `cli`, `panel`, …). */
  readonly source?: string | undefined;
}

/**
 * What the run can put back, as the runner measured it — never as anyone
 * declared it.
 *
 * `tables` is the honest bound on the claim and is carried so the decision can
 * state it: a baseline covers the tables the plan named, and a mutation that
 * reaches beyond them is NOT undone by the restore. The gate grants approval on
 * the strength of the undo it has, and the record says exactly how far that
 * undo reaches, so a reader can judge the residue rather than infer it.
 */
export interface MutationReversibility {
  /** Tables snapshotted AND verified restorable. Empty means no undo at all. */
  readonly tables: readonly string[];
  /** Where the undo comes from, for the record — `db-baseline`, and room for another. */
  readonly by: string;
  /**
   * The written recovery — the `.restore.sql` a person can run to put these
   * tables back (2026-09-09).
   *
   * **This, not a write credential, is what makes the undo real.** The harness
   * performing the restore itself is a convenience; what the gate needs to
   * know is that the way back EXISTS and is recorded, so nothing this action
   * does is unrecoverable. A run with the script and no credential can still
   * be undone — by a person, deliberately, which on a shared environment is
   * often the better order anyway.
   *
   * Absent when no script could be written, and then there is no undo to
   * approve on.
   */
  readonly script?: string | undefined;
}

/** What the gate asks a host to approve, when a policy names no manifest entry for it. */
export interface MutationRequest {
  readonly category: MutationCategory;
  readonly targets: readonly string[];
  readonly selector: string;
  readonly url: string;
  readonly goal: string;
  readonly target?: string | undefined;
  /** Which half of the flow is being asked about; a host may say yes to one and no to the other. */
  readonly phase?: MutationPhase | undefined;
}

/** The host's explicit yes/no. Never derived from the goal or the model. */
export type ApproveMutation = (request: MutationRequest) => Promise<boolean> | boolean;
export type OnMutation = (
  request: MutationRequest & { readonly url: string; readonly decisionAction: string; readonly selector: string },
) => Promise<void> | void;

// --- classification ----------------------------------------------------------

/** Approve / reject, in English and in the sheets' Thai. */
const APPROVE_NAME = /^(?:(approve|reject|authori[sz]e)\b|(อนุมัติ|ไม่อนุมัติ|ปฏิเสธ))/i;
/**
 * A form's commit. `Confirm` is here too, but only as a FALLBACK: inside a
 * destructive dialog it is the second half of a delete, and
 * `mutationCategoryFor` gives it that category instead — see `DESTRUCTIVE_TEXT`.
 */
const SUBMIT_NAME = /^(?:(submit|save|create|confirm|pay|checkout|publish|send|post)\b|(ส่ง|บันทึก|ยืนยัน|สร้าง|ชำระ))/i;

export function mutationCategoryFromName(name: string): MutationCategory | null {
  const trimmed = name.trim();
  if (DESTRUCTIVE_NAME.test(trimmed)) return 'delete';
  if (APPROVE_NAME.test(trimmed)) return 'approve';
  if (SUBMIT_NAME.test(trimmed)) return 'submit';
  return null;
}

export function controlNameFromAriaSnapshot(snapshot: string): string | null {
  const root = snapshot.split('\n').find((line) => line.trim() !== '')?.trim();
  if (root === undefined) return null;
  const encoded = /^-\s+\S+(?:\s+\[[^\]]+\])*\s+"((?:\\.|[^"])*)"/.exec(root)?.[1];
  if (encoded === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(`"${encoded}"`);
    return typeof decoded === 'string' && decoded.trim() !== '' ? decoded.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The mutation category of a decision, or null for an ordinary action.
 *
 * Only an activation with a selector can be one — `click`, or a `press` aimed
 * at a control (a bare key to whatever has focus names no target). The
 * category is read off the accessible name of the control the click LANDS
 * on (`targetName`: the last named role segment), the same reading
 * `unscopedDestructiveClick` uses, so the two guards never disagree about
 * which button is the destructive one.
 */
export function mutationCategoryOf(decision: DecisionLike): MutationCategory | null {
  if (decision.action !== 'click' && decision.action !== 'press') return null;
  if (decision.selector.trim() === '') return null;
  const name = targetName(decision.selector);
  if (name === null) return null;
  return mutationCategoryFromName(name);
}

/**
 * The dialog a click lands inside, when it lands inside one.
 *
 * Read off the live page by the caller — `el.closest('[role=dialog]')` and its
 * text — never from the goal, the model's reasoning or the selector. It is the
 * one fact that separates the two halves of a destructive flow, so it is held
 * to the same standard as provenance: an observation, or nothing.
 */
export interface DialogContext {
  /** The dialog's own text, enough of it to recognise what it is confirming. */
  readonly text: string;
}

/**
 * A destructive verb anywhere in a dialog's text — the confirmation's subject,
 * not a control's name. `DESTRUCTIVE_NAME` is anchored because a control is
 * named by its verb; a dialog says a sentence ("ยืนยันการลบกฎเงื่อนไขสิทธิ์
 * นี้หรือไม่", "This plan will be permanently deleted"), so the verb is looked
 * for anywhere in it.
 */
const DESTRUCTIVE_TEXT = /\b(delete|remove|destroy|purge|discard|erase|deactivate|terminate)\b|ลบ|ปิดใช้งาน|พ้นสภาพ/i;
/** The same, for the categories that are authoritative rather than destructive. */
const APPROVE_TEXT = /\b(approve|reject|authori[sz]e)\b|อนุมัติ|ปฏิเสธ/i;

/** Which half of a destructive flow a click is. Inside a dialog is the half that commits. */
export function mutationPhaseOf(dialog: DialogContext | null | undefined): MutationPhase {
  return dialog ? 'commit' : 'open';
}

/**
 * The category of a click, given what the control is called and what — if
 * anything — it sits inside.
 *
 * The control's own name decides, EXCEPT for one case that used to be decided
 * wrongly: a confirming control (`Confirm`, `ยืนยัน`, `Save`, `OK`) inside a
 * dialog whose text is destructive is the second half of that delete, and
 * takes its category. Without this it read as `submit` — reversible, ungated —
 * and the click that actually destroyed the row was the only one in the flow
 * nothing guarded.
 */
export function mutationCategoryFor(
  decision: DecisionLike,
  observedControlName: string | null | undefined,
  dialog?: DialogContext | null | undefined,
): MutationCategory | null {
  const own = mutationCategoryFromName(observedControlName ?? '') ?? mutationCategoryOf(decision);
  if (own !== 'submit' || !dialog) return own;
  if (DESTRUCTIVE_TEXT.test(dialog.text)) return 'delete';
  if (APPROVE_TEXT.test(dialog.text)) return 'approve';
  return own;
}

/**
 * The identifiers a mutation is scoped to — what provenance must vouch for.
 *
 * Every named segment of the selector EXCEPT the control's own verb
 * (`role=row[name="PL_03_18"] >> role=button[name="Delete"]` → `PL_03_18`;
 * `text=SIT_DUP_DOC >> xpath=.. >> role=button[name="ปิดใช้งาน"]` →
 * `SIT_DUP_DOC`), plus any identifier the goal names that the selector
 * carries. The goal is consulted for WHAT to look for, never for whether it
 * was seen — that answer comes from the ledger alone. A selector that scopes
 * to nothing yields no target and is held before an irreversible action.
 */
export function mutationTargets(
  decision: DecisionLike,
  goal: string,
  dialog?: DialogContext | null | undefined,
): string[] {
  const verb = (targetName(decision.selector) ?? '').trim().toLowerCase();
  const targets: string[] = [];
  const add = (name: string): void => {
    if (name === '' || name.toLowerCase() === verb) return;
    if (!targets.some((t) => t.toLowerCase() === name.toLowerCase())) targets.push(name);
  };
  for (const m of decision.selector.matchAll(/\[name=(?:"([^"]+)"|'([^']+)')|text="?([^">]+?)"?(?=\s*>>|\s*$)/g)) {
    add((m[1] ?? m[2] ?? m[3] ?? '').trim());
  }
  for (const id of goalIdentifiers(goal)) {
    if (selectorCarries(decision.selector, id)) add(id);
  }
  // A confirmation names the record; its button does not. `Confirm` inside
  // "Delete PL_03_18?" scopes to PL_03_18 as surely as a selector that spelled
  // the row out, and it is admissible for the same reason provenance is: the
  // dialog text is something the harness READ off the live page, not something
  // the goal or the model asserted. Without this the commit half of every
  // two-step delete would be held as unscoped — which is not a safety win, it
  // just moves the block to a rule that cannot be satisfied.
  if (dialog) for (const id of goalIdentifiers(dialog.text)) add(id);
  return targets;
}

// --- the provenance ledger ---------------------------------------------------

/** One captured page state, reduced to the texts a target could be matched against. */
interface Snapshot {
  texts: Set<string>;
  at: string;
  url: string;
}

function snapshotOf(nodes: readonly AxNode[], url: string): Snapshot {
  const texts = new Set<string>();
  for (const node of nodes) {
    for (const text of [node.name, node.value, node.description]) {
      const folded = text.trim().toLowerCase();
      if (folded !== '') texts.add(folded);
    }
  }
  return { texts, at: new Date().toISOString(), url };
}

/** The same word-wise rule `selectorGrounded` applies, against one node's text. */
function textShows(text: string, needle: string): boolean {
  if (text.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => text.includes(w));
}

function anyShows(texts: ReadonlySet<string>, target: string): boolean {
  const needle = target.trim().toLowerCase();
  if (needle === '') return false;
  for (const text of texts) if (textShows(text, needle)) return true;
  return false;
}

/**
 * What this session has SEEN, from harness observations only.
 *
 * Fed by the loop from every accessibility capture it makes (`observe`), and
 * from nothing else: not the goal, not the model's reasoning, not a selector
 * it emitted. Reset at the top of every `run()` — a row seen by the previous
 * leg, or the previous case, is not a row this leg has seen. `latest` is the
 * most recent capture, and a gated mutation is judged against that one
 * specifically, so a row that scrolled away, was filtered out, or was
 * already deleted is not acted on because it was once on screen.
 */
export class TargetProvenance {
  #seen = new Set<string>();
  #latest: Snapshot | null = null;

  reset(): void {
    this.#seen = new Set();
    this.#latest = null;
  }

  /** Record a capture. `url` is the page it was taken on. */
  observe(nodes: readonly AxNode[], url: string): void {
    const snapshot = snapshotOf(nodes, url);
    for (const text of snapshot.texts) this.#seen.add(text);
    this.#latest = snapshot;
  }

  /** Has anything captured this session shown the target? */
  observedThisSession(target: string): boolean {
    return anyShows(this.#seen, target);
  }

  /** Is the target in the most recent capture? False when nothing was captured yet. */
  inLatestSnapshot(target: string): boolean {
    return this.#latest !== null && anyShows(this.#latest.texts, target);
  }

  /** The facts about a set of targets, for the record. */
  facts(targets: readonly string[]): ProvenanceFacts {
    return {
      targets: [...targets],
      observedThisSession: targets.filter((t) => this.observedThisSession(t)),
      inLatestSnapshot: targets.filter((t) => this.inLatestSnapshot(t)),
      latestSnapshotAt: this.#latest?.at ?? null,
      latestSnapshotUrl: this.#latest?.url ?? null,
    };
  }
}

// --- the gate ----------------------------------------------------------------

export interface MutationGateInput {
  readonly decision: DecisionLike;
  readonly goal: string;
  readonly url: string;
  readonly policy: MutationPolicy | null;
  readonly provenance: TargetProvenance;
  readonly observedControlName?: string | null | undefined;
  /** The dialog the click lands inside, read off the live page, or null when it lands on the page itself. */
  readonly dialog?: DialogContext | null | undefined;
  /** The host's approval hook, when one is wired. */
  readonly approve?: ApproveMutation | undefined;
}

/**
 * Whether this run can put back what the action changes.
 *
 * One predicate, so "the run has an undo" cannot come to mean two things —
 * and it is a pure function of what the runner measured, with no environment
 * read of its own: a gate that consulted `process.env` would answer
 * differently in a test than in the run it is meant to describe.
 */
export function reversibleHere(policy: MutationPolicy | null | undefined): boolean {
  const r = policy?.reversible;
  // Both halves, and the script is the load-bearing one: tables say WHAT is
  // covered, the script says the way back was actually written down. A
  // snapshot nobody can replay is not an undo.
  return (r?.tables.length ?? 0) > 0 && (r?.script ?? '') !== '';
}

/** The recovery this run recorded, as a line for a person to act on. */
export function recoveryNote(policy: MutationPolicy | null | undefined): string | null {
  const r = policy?.reversible;
  if (!reversibleHere(policy) || r === undefined) return null;
  return (
    `recoverable: ${r.tables.length} table(s) (${r.tables.join(', ')}) were snapshotted before this run — ` +
    `put them back with: psql "$WOWLIDATOR_DB_RESTORE_URL" -v ON_ERROR_STOP=1 -f ${r.script}`
  );
}

function approvedByManifest(
  policy: MutationPolicy | null,
  category: MutationCategory,
  targets: readonly string[],
  phase: MutationPhase,
): boolean {
  for (const entry of policy?.approved ?? []) {
    if (entry.category !== category) continue;
    // An entry naming no phase approves both, which is what every entry
    // written before phases existed meant. One naming a phase approves only
    // that half — the point of the narrowing, so `phase: 'open'` can never
    // become a licence to commit.
    if (entry.phase !== undefined && entry.phase !== phase) continue;
    const target = (entry.target ?? '*').trim();
    if (target === '*' || target === '') return true;
    if (targets.some((t) => t.toLowerCase() === target.toLowerCase())) return true;
  }
  return false;
}

function held(
  input: MutationGateInput,
  category: MutationCategory,
  targets: readonly string[],
  rule: BlockedOutcome['rule'],
  reason: BlockedOutcome['reason'],
  message: string,
  withProvenance: boolean,
  phase?: MutationPhase,
): BlockedOutcome {
  return {
    kind: 'blocked',
    reason,
    rule,
    message,
    category,
    target: targets[0] ?? null,
    policySource: input.policy?.source ?? (input.policy === null ? null : 'unspecified'),
    ...(phase === undefined ? {} : { phase }),
    ...(withProvenance ? { provenance: input.provenance.facts(targets) } : {}),
  };
}

/**
 * Why this mutation must not run, or null when it may.
 *
 * Pure apart from the `approve` hook, which is the one thing here that is
 * allowed to be a question to a person. The category is judged first (a
 * static fact about the run), provenance second (a fact about the page, read
 * off the latest capture the caller made — the caller refreshes it right
 * before asking), approval last (a fact about the host). An ordinary action
 * returns null without touching any of them, which is what keeps every
 * click, fill and goto exactly as fast and as free as before.
 */
export async function gateMutation(input: MutationGateInput): Promise<BlockedOutcome | null> {
  const dialog = input.dialog ?? null;
  const category = mutationCategoryFor(input.decision, input.observedControlName, dialog);
  if (category === null) return null;
  const phase = mutationPhaseOf(dialog);
  const targets = mutationTargets(input.decision, input.goal, dialog);
  const policy = input.policy;

  if (policy !== null) {
    if (policy.deny?.includes(category)) {
      return held(
        input, category, targets, 'policy-deny', 'capability',
        `the run's mutation policy denies "${category}" — "${input.decision.selector}" would ${category} and was not performed`,
        false, phase,
      );
    }
    if (policy.allow !== undefined && !policy.allow.includes(category)) {
      return held(
        input, category, targets, 'policy-allow-list', 'capability',
        `the run's mutation policy allows only ${policy.allow.length === 0 ? 'no mutation category' : policy.allow.join(', ')} — "${input.decision.selector}" would ${category} and was not performed`,
        false, phase,
      );
    }
  }

  if (!IRREVERSIBLE_CATEGORIES.has(category)) return null;

  if (targets.length === 0) {
    return held(
      input, category, targets, 'destructive-unscoped', 'provenance',
      `the ${category} control ${JSON.stringify(input.observedControlName ?? input.decision.selector)} is not scoped to a record identifier — select the row or record explicitly; no action was performed`,
      true, phase,
    );
  }

  for (const target of targets) {
    if (!input.provenance.observedThisSession(target)) {
      return held(
        input, category, [target, ...targets.filter((t) => t !== target)], 'target-never-observed', 'provenance',
        `"${target}" has not been observed on any page this session — a ${category} scoped to it cannot be verified against something the harness never saw; find the row on the page first, or call fail`,
        true, phase,
      );
    }
    if (!input.provenance.inLatestSnapshot(target)) {
      return held(
        input, category, [target, ...targets.filter((t) => t !== target)], 'target-not-in-latest-snapshot', 'provenance',
        `"${target}" was on the page earlier but is not in the latest snapshot — a ${category} must act on what is showing now; bring the row back into view, or call fail`,
        true, phase,
      );
    }
  }

  if (approvedByManifest(policy, category, targets, phase)) return null;
  // **A verified undo is an answer to the approval question** (2026-09-09).
  // Deliberately AFTER the manifest and BEFORE the host hook: a manifest entry
  // is a person's explicit yes and needs no justification, while the host hook
  // is the interactive path a batch run does not have. And deliberately after
  // every capability and provenance check above — reversibility says the change
  // will not outlive the run, never that the action was well-formed. A delete
  // scoped to a row nobody has seen is still held, undo or no undo.
  if (reversibleHere(policy)) return null;
  if (input.approve !== undefined) {
    const yes = await input.approve({
      category,
      targets,
      selector: input.decision.selector,
      url: input.url,
      goal: input.goal,
      phase,
      ...(input.observedControlName === undefined || input.observedControlName === null
        ? {}
        : { target: input.observedControlName }),
    });
    if (yes) return null;
    return held(
      input, category, targets, 'approval-refused', 'approval',
      `the host refused to approve this ${category} of ${targets.map((t) => JSON.stringify(t)).join(', ')}`,
      true, phase,
    );
  }
  const named = targets.map((t) => JSON.stringify(t)).join(', ');
  const entry = `category "${category}", target "${targets[0] ?? '*'}" or "*"`;
  // The advice differs by half, and getting it wrong is worse than giving
  // none: telling someone to pre-approve a delete outright, on a case whose
  // whole point is to cancel one, authorises the very deletion the case
  // exists to prove does not happen.
  return held(
    input, category, targets, 'approval-missing', 'approval',
    phase === 'open'
      ? `this ${category} control may raise a confirmation, and nothing on the page says whether it commits at once — this run's mutation policy pre-approves no ${category} for ${named}. If the case only opens the confirmation and then cancels it, approve the opening half alone: an "approved" entry of ${entry}, phase "open" — the commit inside the dialog still stops without its own yes. Add a phase-less entry, or have the host approve it, only if the ${category} is meant to happen.`
      : `a ${category} confirmed inside this dialog cannot be taken back, and this run's mutation policy pre-approves none for ${named} — add an "approved" entry to the policy (${entry}, phase "commit" or no phase), or have the host approve it`,
    true, phase,
  );
}

// --- the manifest, parsed ----------------------------------------------------

export const MUTATION_POLICY_ENV = 'WOWLIDATOR_MUTATION_POLICY';

/** A policy that could not be read is a configuration fault, and fails before any run starts. */
export class MutationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationPolicyError';
  }
}

const MutationCategorySchema = z.enum(MUTATION_CATEGORIES);
export const MUTATION_PHASES = ['open', 'commit'] as const satisfies readonly MutationPhase[];
const MutationPhaseSchema = z.enum(MUTATION_PHASES);
const ApprovedMutationSchema = z.object({
  category: MutationCategorySchema,
  target: z.string().min(1).optional(),
  phase: MutationPhaseSchema.optional(),
}).strict();
const MutationPolicySchema = z.object({
  allow: z.array(MutationCategorySchema).optional(),
  deny: z.array(MutationCategorySchema).optional(),
  approved: z.array(ApprovedMutationSchema).optional(),
}).strict();

/**
 * Parse a manifest from JSON text. Strict: an unknown category, a
 * non-object, a malformed approval entry are each a fault, because a policy
 * that silently dropped its `deny` list would be worse than none.
 */
export function parseMutationPolicy(text: string, source = 'manifest'): MutationPolicy {
  const where = `mutation policy (${source}) is not valid`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new MutationPolicyError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = MutationPolicySchema.safeParse(raw);
  if (!parsed.success) throw new MutationPolicyError(`${where}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, source };
}

/** The policy `WOWLIDATOR_MUTATION_POLICY` names, or null when unset. Throws `MutationPolicyError` on a bad one. */
export function mutationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MutationPolicy | null {
  const text = env[MUTATION_POLICY_ENV]?.trim();
  if (text === undefined || text === '') return null;
  return parseMutationPolicy(text, 'env');
}
