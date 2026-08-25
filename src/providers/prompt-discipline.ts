/**
 * The parts of a prompt that make a model answer the SAME way twice.
 *
 * Every model-facing module in this codebase runs at `temperature: 0`, and
 * that removed the sampling half of run-to-run variance. The other half was
 * never sampling: it is a prompt of fifty true rules and no order to apply
 * them in, no rule for what to do when two of them pull apart, and no moment
 * at which the model checks its own answer against them. Measured on the
 * catalog path, one claim authored as 25 steps one run and 29 the next, with
 * a different invented role each time — every step of both flows obeyed every
 * rule. Consistency is a property of the *procedure*, and a prompt that states
 * rules without a procedure leaves the procedure to the model's mood.
 *
 * Three blocks, shared so the discipline is one thing across nine prompts
 * rather than nine slightly different things:
 *
 * - `DETERMINISM_RULES` — same input, same output, and the tie-breaks that
 *   make "same" decidable: shortest first, then earliest in the source order.
 * - `procedure()` — a numbered order of decisions. Given the same evidence,
 *   a model that follows the same steps arrives at the same answer; one that
 *   free-associates over the same rules does not.
 * - `selfCheck()` — the checklist the model runs before answering. Stated as
 *   "fix the answer, never explain the miss": an explained violation still
 *   ships the violation.
 *
 * Zero-shot on purpose. An example teaches the surface of one answer and is
 * copied where it does not fit; a procedure teaches how any answer is built.
 * Nothing here is an example.
 */

export const DETERMINISM_RULES = `DETERMINISM — the same evidence must produce the same answer.
- Do not vary wording, naming, ordering or step count for taste. If two
  answers both satisfy every rule, choose the shorter; if still tied, the one
  whose selectors and values come earlier in the evidence given to you.
- Never add an optional step, an extra assertion, or a "safety" wait that
  nothing in the request or the evidence calls for. Fewer, necessary steps
  are the correct answer; padding is variance.
- Take names, labels, paths and values VERBATIM from the evidence (the tree,
  the request, the inventory). Never paraphrase, never re-case, never
  translate, never "tidy" a value you were given.
- When the evidence does not settle a choice, say so in the field meant for
  it (reasoning / notes / rationale) and take the most conservative option —
  the one that claims least. Do not guess silently.`;

/** A numbered decision order the model must follow, top to bottom. */
export function procedure(title: string, steps: readonly string[]): string {
  const lines = steps.map((step, i) => `${i + 1}. ${step}`);
  return `${title} — follow these in this order, every time:\n${lines.join('\n')}`;
}

/** The checklist run before answering. Failing one means fixing the answer. */
export function selfCheck(items: readonly string[]): string {
  const lines = items.map((item) => `- ${item}`);
  return (
    'BEFORE YOU ANSWER, check every line below against your answer. If one fails,\n' +
    'change the answer until it passes — never explain the miss instead of fixing it:\n' +
    lines.join('\n')
  );
}
