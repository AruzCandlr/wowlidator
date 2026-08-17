/**
 * Visual regression.
 *
 * wowlidator already captures screenshots as *evidence*. This turns them into
 * *assertions*: a CSS regression that makes a page unreadable passes every
 * functional test ever written, because the DOM is fine and only the pixels
 * are wrong. Comparing against a stored baseline is the only way to catch it.
 *
 * Baselines are keyed by an explicit, author-chosen name rather than by step
 * index — inserting a step earlier in a flow must not invalidate every
 * subsequent baseline.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const DEFAULT_BASELINE_DIR = '.wowlidator/baselines';
/** Per-pixel colour distance before a pixel counts as changed (0–1). */
export const DEFAULT_PIXEL_THRESHOLD = 0.1;
/** Fraction of differing pixels tolerated before a snapshot fails. */
export const DEFAULT_DIFF_RATIO = 0.002;

export type SnapshotOutcome = 'created' | 'matched' | 'changed' | 'size-mismatch';

export interface SnapshotResult {
  name: string;
  outcome: SnapshotOutcome;
  /** Fraction of pixels that differ, 0–1. Undefined when sizes differ. */
  diffRatio?: number | undefined;
  changedPixels?: number | undefined;
  totalPixels?: number | undefined;
  baselinePath: string;
  /** Base64 PNG of the diff image, embedded into the report on failure. */
  diffImage?: string | undefined;
  /** Base64 PNG of what was actually rendered, on failure. */
  actualImage?: string | undefined;
  message: string;
}

export interface CompareOptions {
  /** Colour-distance threshold per pixel. */
  pixelThreshold?: number | undefined;
  /** Fraction of differing pixels allowed before failing. */
  maxDiffRatio?: number | undefined;
  /** Overwrite the baseline with what was rendered instead of comparing. */
  updateBaseline?: boolean | undefined;
}

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s === '' ? 'snapshot' : s;
}

/** Absolute path of the baseline PNG for a given flow + snapshot name. */
export function baselinePath(dir: string, flowName: string, snapshotName: string): string {
  return join(resolve(dir), slug(flowName), `${slug(snapshotName)}.png`);
}

/**
 * Compare `actual` (a PNG buffer) against the stored baseline.
 *
 * A missing baseline is **created and passes**, with `outcome: 'created'` —
 * failing a run because it is the first one would make the feature unusable
 * in CI. The result says plainly that nothing was verified.
 */
export async function compareSnapshot(
  actual: Buffer,
  path: string,
  name: string,
  options: CompareOptions = {},
): Promise<SnapshotResult> {
  const pixelThreshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const maxDiffRatio = options.maxDiffRatio ?? DEFAULT_DIFF_RATIO;

  let baselineRaw: Buffer | undefined;
  try {
    baselineRaw = await readFile(path);
  } catch {
    baselineRaw = undefined;
  }

  if (baselineRaw === undefined || options.updateBaseline === true) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, actual);
    return {
      name,
      outcome: 'created',
      baselinePath: path,
      message:
        baselineRaw === undefined
          ? 'baseline created — nothing was verified on this run'
          : 'baseline updated on request',
    };
  }

  const before = PNG.sync.read(baselineRaw);
  const after = PNG.sync.read(actual);

  if (before.width !== after.width || before.height !== after.height) {
    return {
      name,
      outcome: 'size-mismatch',
      baselinePath: path,
      actualImage: actual.toString('base64'),
      message:
        `viewport changed: baseline is ${before.width}×${before.height}, ` +
        `got ${after.width}×${after.height}. Re-record with --update-baselines if intended.`,
    };
  }

  const diff = new PNG({ width: before.width, height: before.height });
  const changedPixels = pixelmatch(
    before.data,
    after.data,
    diff.data,
    before.width,
    before.height,
    { threshold: pixelThreshold },
  );

  const totalPixels = before.width * before.height;
  const diffRatio = totalPixels === 0 ? 0 : changedPixels / totalPixels;

  if (diffRatio <= maxDiffRatio) {
    return {
      name,
      outcome: 'matched',
      diffRatio,
      changedPixels,
      totalPixels,
      baselinePath: path,
      message: `matched (${changedPixels} px differ, within tolerance)`,
    };
  }

  return {
    name,
    outcome: 'changed',
    diffRatio,
    changedPixels,
    totalPixels,
    baselinePath: path,
    diffImage: PNG.sync.write(diff).toString('base64'),
    actualImage: actual.toString('base64'),
    message:
      `${changedPixels} of ${totalPixels} pixels differ ` +
      `(${(diffRatio * 100).toFixed(2)}%, tolerance ${(maxDiffRatio * 100).toFixed(2)}%)`,
  };
}

/** Did this snapshot represent a failure? */
export function isVisualFailure(result: SnapshotResult): boolean {
  return result.outcome === 'changed' || result.outcome === 'size-mismatch';
}
