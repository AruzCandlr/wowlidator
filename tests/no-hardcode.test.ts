/**
 * The harness is universal: no case id, panel job, ledger run key or one
 * catalog's test-data literal may steer executable code. Comments and
 * CLAUDE.md files cite live incidents by name on purpose — that is history —
 * so only code lines are scanned. Pinned 2026-09-04 after a day of rails
 * built from ec09 / HIR-EC-002 runs, at the user's ask: "I want it universal".
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..', 'src');
/** Kept copies and the panel's inline HTML/JS bundle are not harness logic. */
const SKIP = /wow-ui-html\.ts$/;

const CASE_ID = /\bHIR-EC-\d+|\b(?:PL|ML|PB|TSH|TM)_\d{2}_\d{2}\b|\bHIREC\d{3}\b/;
const RUN_ARTEFACT = /\bjob-\d+\b|\b(?:ec09|ec10|be100|enhx4)\b|@2026-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}/i;
const CATALOG_VALUE = /\b1999900123459\b|\b40106337\b|F - DVT|Burapha|admin@cnext\.test|humi-SIT/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') && !SKIP.test(full) ? [full] : [];
  });
}

/** Code lines only: block comments removed, `//` tails and JSDoc/`*` lines dropped. */
function codeLines(source: string): { line: number; text: string }[] {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.split('\n').map((text, i) => ({ line: i + 1, text })).filter(({ text }) => {
    const t = text.trim();
    if (t === '' || t.startsWith('//') || t.startsWith('*')) return false;
    return true;
  }).map(({ line, text }) => ({ line, text: text.replace(/\s\/\/.*$/, '') }));
}

describe('no hardcode: the harness names no case, job, ledger or catalog value in code', () => {
  for (const [label, pattern] of [
    ['a case id', CASE_ID],
    ['a run artefact (panel job, catalog file, run key)', RUN_ARTEFACT],
    ["one catalog's test-data value", CATALOG_VALUE],
  ] as const) {
    it(`never steers on ${label}`, () => {
      const hits: string[] = [];
      for (const file of tsFiles(ROOT)) {
        for (const { line, text } of codeLines(readFileSync(file, 'utf8'))) {
          if (pattern.test(text)) hits.push(`${relative(ROOT, file)}:${line}: ${text.trim().slice(0, 100)}`);
        }
      }
      assert.deepEqual(hits, [], `executable code mentions ${label}:\n${hits.join('\n')}`);
    });
  }
});
