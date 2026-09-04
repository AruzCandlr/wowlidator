/**
 * Plain-text shape of the live run log — what a person scanning a terminal
 * or the panel's job drawer reads. Pure functions plus one piece of ambient
 * state (the log tag), imported by every plane that narrates and by nothing
 * that parses: `.claude/skills/monitor/joblog.mjs` and `src/ui/jobs.ts` read
 * these lines back, so a change of shape here is a change there too.
 *
 * No colour on purpose. The panel shows the raw bytes, and a run log that
 * reads the same in a file, a terminal and a browser is worth more than a
 * green tick.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tag every line of the current async context carries — `[c3]` for a
 * case running in a lane, `[HIR-EC-001]` for a row being authored in a pool.
 *
 * Narration used to be tagged at one call site each: the suite loop tagged
 * its own lines, the authoring pool tagged the lines it knew about, and
 * everything either handed to a shared collaborator (the author's lints,
 * the value resolver, the reviewer, every `[llm]` line on stderr) came out
 * bare and interleaved. A tag on the async context follows the row or the
 * case through every await instead, so `emitTagged(undefined, …)` and the
 * llm log both know whose line it is. Outside any context there is no tag
 * and the output is exactly what it was.
 */
const logTag = new AsyncLocalStorage<string>();

export function withLogTag<T>(tag: string | undefined, fn: () => T): T {
  return tag === undefined ? fn() : logTag.run(tag, fn);
}

export function currentLogTag(): string | undefined {
  return logTag.getStore();
}

/** `850ms`, `12.3s`, `4m24s`, `1h02m` — the widest a human reads at a glance. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m - h * 60).padStart(2, '0')}m`;
}

export const PHASE_RULE_WIDTH = 64;

/** `── authoring HIR-EC-001 ─────────…` — one line a reader can find a phase by. */
export function phaseHeader(label: string): string {
  const head = `── ${label} `;
  return head + '─'.repeat(Math.max(4, PHASE_RULE_WIDTH - head.length));
}

/**
 * Wrap `text` at `width` columns with `indent` on every line after the first.
 * Breaks on spaces only; a run longer than the width (a URL, a selector) is
 * left whole rather than cut. The first line's own indentation is the
 * caller's business — it is measured against `width` as written.
 */
export function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  // The first line keeps the indentation it was written with (`  (1) `).
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  let current = words.length === 0 ? '' : lead;
  let limit = width;
  for (const word of words) {
    if (current === lead || current === '') {
      current = `${current}${word}`;
      continue;
    }
    if (current.length + 1 + word.length > limit) {
      lines.push(current);
      current = `${indent}${word}`;
      limit = width;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** Column widths the step and agent lines share, so their durations line up. */
export const STEP_INDEX_WIDTH = 5;
export const STEP_ACTION_WIDTH = 14;
export const STEP_DURATION_WIDTH = 15;
