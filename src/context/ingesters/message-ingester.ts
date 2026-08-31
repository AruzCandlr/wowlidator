/**
 * Message ingester — the application's own words, as the index's sixth source.
 *
 * Measured 2026-08-28: the graph knew a page's structure (page → screen →
 * modal) and none of its TEXT. The app's 8,319 UI strings live in
 * `messages/en.json` / `th.json` (next-intl), bound by
 * `useTranslations('admin_benefits_plans')` + `t('createPlan')`, and nothing
 * indexed them — so "Benefit Plan Catalog", "Make Correction", every popup
 * title a wording catalog asks about, was answerable only from the live tree,
 * never from the code slice or the BM25 tool. The run's own review said it:
 * "the source index gives no component text or control names".
 *
 * One node per (message file, top-level namespace), not per string: a
 * namespace is exactly the unit a component binds (`useTranslations(ns)`),
 * ~200 nodes per locale file instead of ~8,000, and the strings ride the
 * node's `detail` where the prompt slice prints them and the retrieval
 * corpus indexes them. The component ingester draws the `uses` edge from a
 * component to every locale's node for the namespaces its file names; a
 * namespace no component binds stays an unlinked node the BM25 tool can
 * still find. Same rules as every other ingester: `readFile` + `JSON.parse`,
 * no model, a file too odd to read contributes nothing rather than something
 * wrong.
 */

import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import type { IngestContext, IngestResult, Ingester, ProjectNode } from '../types.js';

/** Where i18n catalogs live, by convention: `messages/en.json`, `locales/th/common.json`, `src/i18n/en.json`… */
const MESSAGE_DIR = /(^|\/)(messages|locales?|i18n|translations|lang)\//;
/** A file stem that names a locale (`en`, `th`, `en-US`, `zh_Hant`). */
const LOCALE_STEM = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;
export const MAX_MESSAGE_FILES = 16;
/** How many `key: "value"` pairs a namespace's detail shows before "(+N more)". */
export const MAX_KEYS_SHOWN = 80;
export const MAX_DETAIL_CHARS = 1_600;
/** A "string" longer than this is a paragraph, not a label; it is counted, not quoted. */
const MAX_VALUE_CHARS = 120;

export function isMessageFile(file: string): boolean {
  if (!file.endsWith('.json') || !MESSAGE_DIR.test(file)) return false;
  const stem = posix.basename(file, '.json');
  // `messages/en.json` (stem is the locale) or `locales/en/common.json`
  // (a locale directory) — both shapes real apps ship.
  const parent = posix.basename(posix.dirname(file));
  return LOCALE_STEM.test(stem) || LOCALE_STEM.test(parent);
}

/** The locale a message file speaks — its stem, or its parent directory. */
export function messageLocale(file: string): string {
  const stem = posix.basename(file, '.json');
  return LOCALE_STEM.test(stem) ? stem : posix.basename(posix.dirname(file));
}

export function messageNodeId(file: string, namespace: string): string {
  return `message:${file}#${namespace}`;
}

/** Depth-first leaf strings under `value`, keyed by dotted path. */
function leaves(value: unknown, path: string, out: [string, string][]): void {
  if (typeof value === 'string') {
    out.push([path, value]);
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    leaves(child, path === '' ? key : `${path}.${key}`, out);
  }
}

/**
 * Keys that name what a page SHOWS — headings, titles, breadcrumbs, the
 * words on buttons and dialogs. These are what a wording claim asks about,
 * so they are quoted ahead of everything else.
 */
const LABEL_KEY = /title|heading|header|label|breadcrumb|button|btn|tag|dialog|modal|popup|page|menu|name|action|confirm/i;

/**
 * The `detail` line: the namespace's strings, the ones a claim asks about
 * first — label-shaped keys, then the rest shortest-first — filled to the
 * character budget rather than a fixed count. Measured 2026-08-28 on the
 * live catalog: shortest-first with a 40-pair cut quoted "All", "Save",
 * "Next" and dropped `title: "Benefit Plan Catalog"` — the one string the
 * wording case needed — with 500 chars of budget unused.
 */
export function describeStrings(pairs: readonly [string, string][]): string {
  const ranked = pairs
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v], at) => ({ k, v, at, label: LABEL_KEY.test(k) ? 0 : 1 }))
    .sort((a, b) => a.label - b.label || a.v.length - b.v.length || a.at - b.at);
  const parts: string[] = [];
  let length = 0;
  for (const { k, v } of ranked) {
    if (parts.length >= MAX_KEYS_SHOWN) break;
    const part = `${k}: ${JSON.stringify(v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…` : v)}`;
    if (length + part.length + 3 > MAX_DETAIL_CHARS) break;
    parts.push(part);
    length += part.length + 3;
  }
  const more = pairs.length - parts.length;
  return more > 0 ? `${parts.join(' · ')} (+${more} more)` : parts.join(' · ');
}

export class MessageIngester implements Ingester {
  readonly id = 'message';

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const warnings: string[] = [];
    const nodes: ProjectNode[] = [];
    const candidates = ctx.files.filter(isMessageFile);
    const targets = candidates.slice(0, MAX_MESSAGE_FILES);
    if (candidates.length > targets.length) {
      warnings.push(`${candidates.length} message files found, only indexing the first ${MAX_MESSAGE_FILES}`);
    }
    for (const file of targets) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(posix.join(ctx.rootDir, file), 'utf8'));
      } catch (error) {
        warnings.push(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const locale = messageLocale(file);
      // Group by top-level namespace — nested objects (`{ plans: { title } }`)
      // and flat dotted keys (`"plans.title"`) both bind as `useTranslations('plans')`.
      const byNamespace = new Map<string, [string, string][]>();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const dot = key.indexOf('.');
        const namespace = dot > 0 ? key.slice(0, dot) : key;
        const rest = dot > 0 ? key.slice(dot + 1) : '';
        const pairs: [string, string][] = [];
        leaves(value, rest, pairs);
        if (pairs.length === 0) continue;
        const bucket = byNamespace.get(namespace) ?? [];
        bucket.push(...pairs);
        byNamespace.set(namespace, bucket);
      }
      for (const [namespace, pairs] of byNamespace) {
        nodes.push({
          id: messageNodeId(file, namespace),
          kind: 'message',
          name: namespace,
          file,
          detail: describeStrings(pairs),
          meta: { locale, keys: String(pairs.length) },
        });
      }
    }
    return { nodes, edges: [], warnings };
  }
}
