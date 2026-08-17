/**
 * Flow composition: `use` fragments and their parameters.
 *
 * ## Why this exists
 *
 * A journey through a real application has preludes. "Act as the HRBP" is
 * three clicks through an identity menu, it is identical in every HRBP test,
 * and it is not what any of those tests is about. Copying it into each flow
 * makes the interesting steps hard to find and guarantees that when the menu
 * changes, some flows are updated and some are not.
 *
 * A fragment is an ordinary `.flow.json` — runnable on its own, so it can be
 * debugged on its own — pulled into another flow by a `use` step:
 *
 * ```json
 * { "action": "use", "flow": "fragments/act-as.flow.json", "with": { "role": "HRB001" } }
 * ```
 *
 * ## Expansion happens before the run, not during it
 *
 * `expandFlow()` splices the fragment's steps into the caller and returns a
 * plain `Flow` that the runner executes with no knowledge that composition
 * ever happened. Two things fall out of that, and both matter more than the
 * small amount of cleverness a lazy `use` would have bought:
 *
 * - the proof bundle records the *real* steps, so a report reads as what
 *   actually happened rather than "used a fragment";
 * - `--repair`'s `locateFailedStep()`, which maps bundle entries back onto
 *   `setup`/`steps` positionally, keeps working unchanged.
 *
 * ## Parameters are substituted textually, and only the ones you passed
 *
 * `with` values replace `{{name}}` inside the fragment at expansion time. Any
 * other `{{...}}` is left alone — those belong to the runtime variable store
 * (`src/api/variables.ts`), which is how a value saved from an HTTP response
 * reaches a later step. Substituting everything here would break that; leaving
 * everything to runtime would mean a fragment's selectors never appear in the
 * flow you can read on disk.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { Flow, FlowStep } from './runner.js';

/** How deep `use` may nest before we call it a mistake. */
export const DEFAULT_MAX_INCLUDE_DEPTH = 3;

export class FlowCompositionError extends Error {
  override readonly name = 'FlowCompositionError';
}

export interface ExpandOptions {
  /** Directory `use` paths are resolved against — normally the flow's own. */
  dir?: string | undefined;
  maxDepth?: number | undefined;
  /** Injected for tests; defaults to reading from disk. */
  read?: ((path: string) => Promise<string>) | undefined;
}

/** Steps that carry nested steps, and therefore need expanding too. */
function branchesOf(step: FlowStep): FlowStep[][] {
  if (step.action !== 'when') return [];
  return step.else ? [step.then, step.else] : [step.then];
}

/**
 * Replace every `use` step with the steps of the flow it names.
 *
 * The returned flow contains no `use` steps at any depth.
 */
export async function expandFlow(flow: Flow, options: ExpandOptions = {}): Promise<Flow> {
  const dir = options.dir ?? process.cwd();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'));

  const expand = async (
    steps: readonly FlowStep[],
    baseDir: string,
    depth: number,
    /** Files on the current include path — cycle detection, not memoisation. */
    stack: readonly string[],
  ): Promise<FlowStep[]> => {
    const out: FlowStep[] = [];

    for (const step of steps) {
      if (step.action === 'when') {
        const then = await expand(step.then, baseDir, depth, stack);
        const otherwise = step.else ? await expand(step.else, baseDir, depth, stack) : undefined;
        out.push(otherwise ? { ...step, then, else: otherwise } : { ...step, then });
        continue;
      }

      if (step.action !== 'use') {
        out.push(step);
        continue;
      }

      if (depth >= maxDepth) {
        throw new FlowCompositionError(
          `"use" nested more than ${maxDepth} deep (at "${step.flow}") — ` +
            'a fragment that includes a fragment that includes a fragment is usually a loop',
        );
      }

      const path = isAbsolute(step.flow) ? step.flow : resolve(baseDir, step.flow);
      if (stack.includes(path)) {
        throw new FlowCompositionError(
          `"use" cycle: ${[...stack, path].map((p) => `"${p}"`).join(' → ')}`,
        );
      }

      let fragment: Flow;
      try {
        fragment = JSON.parse(await read(path)) as Flow;
      } catch (error) {
        throw new FlowCompositionError(
          `could not load the flow "${step.flow}" used here: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (fragment.teardown?.length) {
        // Silently dropping it would leave a fragment author believing their
        // cleanup runs. Running it inline would run cleanup in the middle of
        // the caller's flow, which is worse.
        throw new FlowCompositionError(
          `the flow "${step.flow}" has a teardown, so it cannot be used as a fragment — ` +
            'teardown would run in the middle of the including flow, not at its end',
        );
      }

      const body = [...(fragment.setup ?? []), ...fragment.steps];
      const parameterised = step.with ? substitute(body, step.with) : body;
      out.push(...(await expand(parameterised, dirname(path), depth + 1, [...stack, path])));
    }

    return out;
  };

  const expanded: Flow = {
    ...flow,
    steps: await expand(flow.steps, dir, 0, []),
  };
  if (flow.setup) expanded.setup = await expand(flow.setup, dir, 0, []);
  if (flow.teardown) expanded.teardown = await expand(flow.teardown, dir, 0, []);
  return expanded;
}

/** True when any step (at any nesting) is a `use`. */
export function hasIncludes(flow: Flow): boolean {
  const scan = (steps: readonly FlowStep[]): boolean =>
    steps.some(
      (step) => step.action === 'use' || branchesOf(step).some((branch) => scan(branch)),
    );
  return scan(flow.steps) || scan(flow.setup ?? []) || scan(flow.teardown ?? []);
}

/**
 * Replace `{{name}}` with the value given for `name`, everywhere in a set of
 * steps. Placeholders with no matching parameter are left untouched for the
 * runtime variable store to resolve.
 */
function substitute(steps: readonly FlowStep[], params: Record<string, string>): FlowStep[] {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        Object.hasOwn(params, name) ? (params[name] ?? '') : whole,
      );
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(steps) as FlowStep[];
}
