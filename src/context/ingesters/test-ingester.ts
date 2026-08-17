/**
 * Indexes what is already tested, from two sources:
 *
 * - Generic test files (Playwright/Jest/Vitest/`node:test`/Cypress): title
 *   strings are pulled from `describe`/`it`/`test` calls via the real parser,
 *   so the graph knows a test exists even though its body is opaque to us.
 * - wowlidator's own flow JSON (`*.flow.json`, generated `suite.json`): these are
 *   MY format, so unlike the generic case the `goto` URLs inside them can be
 *   read reliably and are recorded in `meta.urls` — `ContextEngine` uses that
 *   to link a flow to the route it exercises.
 */

import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';

import type { Flow, FlowStep } from '../../engine/runner.js';
import { hasAssertion } from '../../engine/runner.js';
import type { IngestContext, IngestResult, Ingester, ProjectNode } from '../types.js';

const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;
const FLOW_FILE_RE = /\.flow\.json$/;
const TEST_CALL_NAMES = new Set(['describe', 'it', 'test']);
const MAX_TITLES = 8;

function isNode(value: unknown): value is t.Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function forEachChild(node: t.Node, visit: (child: t.Node) => void): void {
  const keys = (t.VISITOR_KEYS as Record<string, string[] | undefined>)[node.type] ?? [];
  const record = node as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item);
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

/** Pulled with `@babel/parser` rather than the TypeScript compiler — see `component-ingester.ts` for why. */
function extractTitles(text: string): string[] {
  const titles: string[] = [];
  let program: t.File;
  try {
    program = parse(text, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });
  } catch {
    return titles;
  }

  const visit = (node: t.Node): void => {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee) && TEST_CALL_NAMES.has(node.callee.name)) {
      const [firstArg] = node.arguments;
      if (firstArg && t.isStringLiteral(firstArg)) titles.push(firstArg.value);
    }
    forEachChild(node, visit);
  };
  visit(program);
  return titles;
}

function guessFramework(text: string): string {
  if (/from\s+['"]@playwright\/test['"]/.test(text)) return 'playwright';
  if (/from\s+['"]vitest['"]/.test(text)) return 'vitest';
  if (/from\s+['"]node:test['"]/.test(text)) return 'node:test';
  if (/from\s+['"]cypress['"]/.test(text) || /\bcy\.visit\(/.test(text)) return 'cypress';
  if (/from\s+['"]@jest\/globals['"]/.test(text) || /\bjest\.fn\(/.test(text)) return 'jest';
  return 'unknown';
}

function isFlowShape(value: unknown): value is Flow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Flow).name === 'string' &&
    Array.isArray((value as Flow).steps)
  );
}

interface SuiteShape {
  cases: Array<{ name: string; flow: Flow }>;
}

function isSuiteShape(value: unknown): value is SuiteShape {
  return typeof value === 'object' && value !== null && Array.isArray((value as SuiteShape).cases);
}

function gotoUrls(flow: Flow): string[] {
  const urls = new Set<string>();
  const collect = (steps: FlowStep[] | undefined): void => {
    for (const step of steps ?? []) {
      if (step.action === 'goto') urls.add(step.url);
    }
  };
  collect(flow.setup);
  collect(flow.steps);
  collect(flow.teardown);
  return [...urls];
}

/**
 * `METHOD url` for every `request` step — the backend counterpart of
 * `gotoUrls`, and readable for exactly the same reason: this is our own
 * format, so unlike a Playwright spec's opaque body we can see what it calls.
 */
function requestedEndpoints(flow: Flow): string[] {
  const calls = new Set<string>();
  const collect = (steps: FlowStep[] | undefined): void => {
    for (const step of steps ?? []) {
      if (step.action === 'request') calls.add(`${step.method.toUpperCase()} ${step.url}`);
    }
  };
  collect(flow.setup);
  collect(flow.steps);
  collect(flow.teardown);
  return [...calls];
}

function flowNode(file: string, id: string, flow: Flow, nameOverride?: string): ProjectNode {
  return {
    id,
    kind: 'test',
    name: nameOverride ?? flow.name,
    file,
    meta: {
      framework: 'wowlidator-flow',
      steps: String(flow.steps.length),
      hasAssertion: String(hasAssertion(flow.steps)),
      urls: gotoUrls(flow).join(','),
      // Comma-joined like `urls`; a url containing a comma would be
      // mis-split, which is why both are only ever read back by our own
      // linking pass and never treated as authoritative.
      calls: requestedEndpoints(flow).join(','),
    },
  };
}

export class TestIngester implements Ingester {
  readonly id = 'test';

  async ingest(ctx: IngestContext): Promise<IngestResult> {
    const nodes: ProjectNode[] = [];
    const warnings: string[] = [];

    for (const file of ctx.files) {
      if (TEST_FILE_RE.test(file)) {
        try {
          const text = await readFile(posix.join(ctx.rootDir, file), 'utf8');
          const titles = extractTitles(text);
          nodes.push({
            id: `test:${file}`,
            kind: 'test',
            name: file.split('/').pop() ?? file,
            file,
            detail: titles.slice(0, MAX_TITLES).join(' · ') || undefined,
            meta: { framework: guessFramework(text), cases: String(titles.length) },
          });
        } catch (error) {
          warnings.push(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      if (FLOW_FILE_RE.test(file) || file === 'suite.json' || file.endsWith('/suite.json')) {
        try {
          const text = await readFile(posix.join(ctx.rootDir, file), 'utf8');
          const parsed: unknown = JSON.parse(text);

          if (isFlowShape(parsed)) {
            nodes.push(flowNode(file, `test:${file}`, parsed));
          } else if (isSuiteShape(parsed)) {
            parsed.cases.forEach((testCase, index) => {
              nodes.push(flowNode(file, `test:${file}#${index}`, testCase.flow, testCase.name));
            });
          }
        } catch (error) {
          warnings.push(`could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return { nodes, edges: [], warnings };
  }
}
