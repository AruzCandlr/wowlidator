/**
 * Test polarity — whether a test means to prove acceptance or refusal — and
 * the expected/actual evidence line every assertion now records.
 *
 * All unit-tier: classification is a pure function of the flow's own words
 * and step shapes (never a model call, so the same flow classifies the same
 * way on every run), the bundle plumbing is a pure builder, and the report is
 * a pure function of the bundle.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inferPolarity, statedPolarity } from '../src/engine/polarity.js';
import {
  ProofBundleBuilder,
  expectedActual,
  formatStepLine,
  type ProofBundle,
  type ProofStep,
} from '../src/engine/proof-bundle.js';
import { renderReport } from '../src/reporter/html-reporter.js';

describe('statedPolarity', () => {
  it('normalises the sheet column and refuses to guess a blank', () => {
    assert.equal(statedPolarity('Negative'), 'negative');
    assert.equal(statedPolarity('neg'), 'negative');
    assert.equal(statedPolarity('POSITIVE'), 'positive');
    assert.equal(statedPolarity('Pos'), 'positive');
    // A blank or unreadable cell must fall through to inference — defaulting
    // it to positive by string accident would silently mislabel the test.
    assert.equal(statedPolarity(''), undefined);
    assert.equal(statedPolarity('  '), undefined);
    assert.equal(statedPolarity('n/a'), undefined);
    assert.equal(statedPolarity(undefined), undefined);
  });
});

describe('inferPolarity', () => {
  it('reads refusal wording, English and Thai', () => {
    assert.equal(inferPolarity('submit an invalid email and see the error message'), 'negative');
    assert.equal(inferPolarity('an HRBP cannot approve their own request'), 'negative');
    assert.equal(inferPolarity('access is denied for the employee persona'), 'negative');
    assert.equal(inferPolarity('กรอกอีเมลไม่ถูกต้อง'), 'negative');
    assert.equal(inferPolarity('ผู้ใช้ไม่มีสิทธิ์เข้าถึงหน้านี้'), 'negative');
  });

  it('reads step shapes that can only mean refusal', () => {
    assert.equal(
      inferPolarity('probe the endpoint', [{ action: 'expectStatus', status: 422 }]),
      'negative',
    );
    assert.equal(
      inferPolarity('probe the endpoint', [{ action: 'expectStatus', status: [401, 403] }]),
      'negative',
    );
    assert.equal(
      inferPolarity('save the order', [{ action: 'expectCalls', never: [{ url: '/api/x' }] }]),
      'negative',
    );
  });

  it('does not call a tolerance a refusal, and defaults to positive', () => {
    // A list mixing success and error statuses is a tolerance, not a claim
    // that the request must be refused.
    assert.equal(
      inferPolarity('the endpoint answers', [{ action: 'expectStatus', status: [200, 422] }]),
      'positive',
    );
    // expectHidden alone is NOT negative — it is also the canonical login
    // proof ("the submit control is gone"), which is a positive claim.
    assert.equal(
      inferPolarity('sign in as the admin', [{ action: 'expectHidden' }]),
      'positive',
    );
    assert.equal(inferPolarity('create an overtime request and see it listed'), 'positive');
  });
});

const base = { startedAt: '2026-08-20T10:00:00.000Z', durationMs: 120, url: 'http://app/x' };

function bundleOf(
  options: ConstructorParameters<typeof ProofBundleBuilder>[0],
  build: (b: ProofBundleBuilder) => void,
): ProofBundle {
  const builder = new ProofBundleBuilder(options);
  build(builder);
  return builder.finish();
}

describe('polarity on the bundle', () => {
  it('carries the label and its source; absent stays absent', () => {
    const labelled = bundleOf(
      { name: 'neg case', cdpUrl: null, cachePath: null, polarity: 'negative', polaritySource: 'stated' },
      () => {},
    );
    assert.equal(labelled.polarity, 'negative');
    assert.equal(labelled.polaritySource, 'stated');

    const bare = bundleOf({ name: 'old bundle', cdpUrl: null, cachePath: null }, () => {});
    assert.equal(bare.polarity, undefined);
    assert.equal(bare.polaritySource, undefined);
  });
});

describe('expectedActual', () => {
  const step = (detail: Record<string, unknown> | undefined): ProofStep => ({
    index: 0,
    action: 'expectText',
    selector: 'body',
    resolvedSelector: 'body',
    resolution: 'fast',
    status: 'passed',
    detail,
    ...base,
  });

  it('renders both halves when the step recorded them', () => {
    assert.equal(
      expectedActual(step({ expected: '119 days', actual: 'Remaining: 119 days' })),
      'expected "119 days" · actual "Remaining: 119 days"',
    );
    assert.equal(expectedActual(step({ expected: 4, actual: 3 })), 'expected 4 · actual 3');
  });

  it('says nothing about a step that recorded neither, or only undefined', () => {
    assert.equal(expectedActual(step(undefined)), null);
    assert.equal(expectedActual(step({ selector: 'x' })), null);
    assert.equal(expectedActual(step({ expected: undefined })), null);
  });

  it('lands on the live CLI step line', () => {
    const line = formatStepLine(step({ expected: 'visible', actual: 'visible' }));
    assert.match(line, /expected "visible" · actual "visible"/);
  });
});

describe('the report shows the comparison and the polarity', () => {
  const bundle = bundleOf(
    { name: 'neg case', cdpUrl: null, cachePath: null, polarity: 'negative', polaritySource: 'stated' },
    (b) => {
      b.addStep({
        action: 'expectText',
        intent: 'The validation error appears',
        selector: 'body',
        resolvedSelector: 'body',
        resolution: 'fast',
        status: 'passed',
        detail: { expected: 'Email is invalid', actual: 'Email is invalid — try again' },
        ...base,
      });
    },
  );

  it('renders the polarity pill and the expected/actual line', () => {
    const html = renderReport(bundle);
    assert.match(html, /negative test/);
    assert.match(html, /step-compare/);
    assert.match(html, /Email is invalid — try again/);
  });

  it('does not double-render expected/actual in the generic detail dump', () => {
    const html = renderReport(bundle);
    // The dedicated line renders them once; the kv dump must not repeat the
    // same values as <dt>expected</dt>/<dt>actual</dt> rows.
    assert.doesNotMatch(html, /<dt>expected<\/dt>/);
    assert.doesNotMatch(html, /<dt>actual<\/dt>/);
  });

  it('a bundle with no polarity renders no pill', () => {
    const bare = bundleOf({ name: 'old', cdpUrl: null, cachePath: null }, () => {});
    const html = renderReport(bare);
    assert.doesNotMatch(html, /class="polarity/);
  });
});
