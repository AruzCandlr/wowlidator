/**
 * Report comprehension: the verdict paragraph, the escalation trace prose, the
 * glossary, and the three reading layers (spec R1, R2, R4).
 *
 * Entirely unit-tier. Every claim the report makes about a run is a pure
 * function of the bundle, which is the point of `src/reporter/verdict.ts` —
 * the wording is as testable as any other output, and a sentence that stops
 * matching the evidence fails here rather than misleading a reader.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProofBundleBuilder, type ProofBundle } from '../src/engine/proof-bundle.js';
import { GLOSSARY, renderReport } from '../src/reporter/html-reporter.js';
import { buildVerdict, escalationTrace, ownerOf, describeStep } from '../src/reporter/verdict.js';
import { decisionFrom } from '../src/engine/runner.js';

const base = { startedAt: '2026-08-03T00:00:00.000Z', durationMs: 12, url: 'http://app/x' };

function bundleOf(
  build: (b: ProofBundleBuilder) => void,
  meta: { name?: string } = {},
): ProofBundle {
  const builder = new ProofBundleBuilder({
    name: meta.name ?? 'probation filter',
    cdpUrl: null,
    cachePath: null,
  });
  build(builder);
  return builder.finish();
}

describe('verdict — what broke', () => {
  it("uses the author's own words rather than the selector", () => {
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'click',
        intent: 'Click Due Soon filter button',
        selector: 'role=button[name="DUE SOON" i]',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'could not resolve "role=button[name="DUE SOON" i]" after 2 attempt(s):\n  - fast: Timeout',
      });
    });
    const verdict = buildVerdict(bundle);

    assert.equal(verdict.status, 'failed');
    assert.match(verdict.headline, /^FAILED — probation filter$/);
    assert.match(verdict.what, /"Click Due Soon filter button"/);
    assert.match(verdict.what, /the control it needed was never found/);
    assert.equal(verdict.firstFailingStep, 0);
  });

  it('leads with what the page was showing, before the resolution mechanics', () => {
    // PB-02-01: the page said "Access Denied" and the report said "could not
    // resolve". The captured page state is the diagnosis; it goes first.
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'expectVisible',
        intent: 'the Probation Exemption card',
        selector: 'text=Probation Exemption',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'could not resolve "text=Probation Exemption" after 2 attempt(s):\n  - fast: Timeout',
        pageContext: ['ไม่มีสิทธิ์เข้าถึง · Access Denied'],
      });
    });
    const verdict = buildVerdict(bundle);

    assert.match(verdict.what, /^The page was showing "ไม่มีสิทธิ์เข้าถึง · Access Denied" at the moment of failure\./);
    assert.match(verdict.what, /never found/);
  });

  it('renders page context, rejected repairs, and doubt badges as evidence', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
      b.addStep({
        action: 'click',
        selector: '#go',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'could not resolve "#go"',
        pageContext: ['Access Denied'],
        rejectedHeals: [
          {
            proposed: 'role=heading[name="Access Denied"]',
            confidence: 0.1,
            reasoning: 'only a denial heading is present',
            rejectedBecause: 'confidence 0.10 below threshold 0.5',
          },
        ],
      });
      // An absence check passing after the failure: true, but not evidence.
      b.addStep({ action: 'expectHidden', selector: 'text=Exemption', resolvedSelector: null, resolution: 'fast', status: 'passed', ...base });
      // A later failure is possibly a consequence of the first.
      b.addStep({ action: 'expectVisible', selector: '#x', resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'boom' });
    });

    const html = renderReport(bundle);
    assert.match(html, /What the page was showing/);
    assert.match(html, /Repairs proposed and refused/);
    assert.match(html, /only a denial heading is present/);
    assert.match(html, /passed, in doubt/);
    assert.match(html, /downstream/);
  });

  it('reads as a connected journey, and opens on the moment it snapped', () => {
    const bundle = bundleOf((b) => {
      b.setVideoStart(Date.parse(base.startedAt) - 100);
      b.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base, screenshot: 'AAAA' });
      b.addStep({
        action: 'click', selector: '#x', resolvedSelector: null, resolution: null, status: 'failed',
        ...base, error: 'boom', screenshot: 'BBBB',
      });
      b.setVideo({ width: 960, height: 540, bytes: 10, durationMs: 60_000, data: 'AAAA', endsAtStep: 1 });
    });
    // reclassify to the taxonomy the strip must recognise — 'failed' alone
    // once missed 'error' and 'dead-end' frames entirely.
    bundle.steps[1]!.status = 'dead-end';

    const html = renderReport(bundle);
    // The player opens ON the failure: the offset is server-rendered so the
    // first frame a reader sees is the one the recording was kept for.
    assert.match(html, /data-failure-offset="/);
    // The strip's client script connects frames with arrows and highlights
    // every non-pass status, not just literal 'failed'.
    assert.match(html, /'dead-end'/);
    assert.match(html, /firstBroken/);
    assert.match(html, /→/);
    // The film is subtitled: one segment per filmed step, and the failing
    // segment says how it failed.
    assert.match(html, /data-segments="/);
    assert.match(html, /video-subtitle/);
    assert.match(html, /&quot;failed&quot;:true/);
  });

  it('falls back to the action and selector when a step carries no intent', () => {
    const step = {
      index: 3,
      action: 'click',
      selector: '#go',
      resolvedSelector: null,
      resolution: null,
      status: 'failed' as const,
      ...base,
    };
    assert.equal(describeStep(step), 'Step 3 (click #go)');
  });

  it('says a passing run passed, in one line, with no blame to assign', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
      b.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
    });
    const verdict = buildVerdict(bundle);

    assert.equal(verdict.status, 'passed');
    assert.match(verdict.what, /All 2 steps did what the test said/);
    assert.equal(verdict.side, null);
    assert.equal(verdict.owner, null);
  });
});

describe('verdict — which side', () => {
  it('blames the frontend and cites the clean traffic as evidence', () => {
    const bundle = bundleOf((b) => {
      b.setNetworkTotals({ calls: 3, failures: 0, dropped: 0 });
      b.addStep({
        action: 'click',
        intent: 'Open the filter',
        selector: '#f',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'could not resolve "#f" after 2 attempt(s):\n  - fast: Timeout',
      });
      b.addDefect({ id: 'd1', source: 'runtime', category: 'functional', severity: 'high', title: 'Step failed', detail: '', stepIndex: 0 });
    });
    const verdict = buildVerdict(bundle);

    assert.equal(verdict.owner, 'frontend');
    assert.match(verdict.side ?? '', /FRONTEND problem/);
  });

  it('blames the backend when the failing step spoke HTTP', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ action: 'request', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
      b.addStep({
        action: 'expectStatus',
        intent: 'The endpoint answers',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'expected status 200, got 500 Internal Server Error',
      });
      b.addDefect({ id: 'd1', source: 'runtime', category: 'backend', severity: 'high', title: 'Assertion failed', detail: '', stepIndex: 1 });
    });
    const verdict = buildVerdict(bundle);

    assert.equal(verdict.owner, 'backend');
    assert.match(verdict.side ?? '', /BACKEND problem/);
    assert.match(verdict.side ?? '', /No amount of selector work will fix it/);
    assert.match(verdict.what, /did not answer as expected/);
  });

  it('reports both when both halves broke, and says which to fix first', () => {
    const bundle = bundleOf((b) => {
      b.addStep({ action: 'click', selector: '#a', resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'could not resolve "#a"' });
      b.addStep({ action: 'expectStatus', selector: null, resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'expected status 200, got 500' });
    });
    assert.equal(ownerOf(bundle), 'mixed');
    assert.match(buildVerdict(bundle).side ?? '', /treat the backend failures first/);
  });
});

describe('escalation trace, told as a sequence', () => {
  it('rewrites each rung as prose while keeping the raw message', () => {
    const rungs = escalationTrace(
      'could not resolve "#a" after 3 attempt(s):\n' +
        '  - fast "#a": locator.click: Timeout 2000ms exceeded.\n' +
        '  - case "#a i": locator.click: Timeout 2000ms exceeded.\n' +
        '  - jit: healed selector did not resolve',
    );

    assert.deepEqual(rungs.map((r) => r.rung), ['fast', 'case', 'jit']);
    assert.match(rungs[0]!.prose, /exactly as the test wrote it/);
    assert.match(rungs[1]!.prose, /ignoring letter-case/);
    assert.match(rungs[2]!.prose, /Asked the model/);
    assert.match(rungs[0]!.detail, /Timeout 2000ms/, 'the evidence survives verbatim');
  });

  it('names the dialog rung by what it did', () => {
    const rungs = escalationTrace(
      'could not resolve "#a" after 2 attempt(s):\n  - fast (after dismissing "Special offer") "#a": Timeout',
    );
    assert.equal(rungs[0]?.rung, 'dialog');
    assert.match(rungs[0]?.prose ?? '', /Dismissed the "Special offer" dialog/);
  });

  it('passes an unknown rung through rather than dropping it', () => {
    // A rung added later must never silently vanish from the account of what
    // was tried — that is worse than showing an unpolished name.
    const rungs = escalationTrace('could not resolve "#a":\n  - telepathy "#a": no luck');
    assert.equal(rungs[0]?.rung, 'telepathy');
    assert.match(rungs[0]?.prose ?? '', /telepathy/);
  });

  it('returns nothing for an error that is not an escalation trace', () => {
    assert.deepEqual(escalationTrace('expected status 200, got 404'), []);
    assert.deepEqual(escalationTrace(undefined), []);
  });
});

describe('the rendered report', () => {
  const failing = bundleOf((b) => {
    b.addStep({
      action: 'click',
      intent: 'Click Due Soon filter button',
      selector: 'role=button[name="DUE SOON" i]',
      resolvedSelector: null,
      resolution: null,
      status: 'failed',
      ...base,
      error: 'could not resolve "role=button[name="DUE SOON" i]" after 2 attempt(s):\n  - fast "x": Timeout\n  - jit: no',
    });
  });

  it('opens with the verdict, before any machinery', () => {
    const html = renderReport(failing);
    const verdictAt = html.indexOf('class="verdict');
    const cardsAt = html.indexOf('class="cards');
    const diagnosticsAt = html.indexOf('class="diagnostics"');

    assert.ok(verdictAt > 0, 'the verdict block is rendered');
    assert.ok(verdictAt < cardsAt, 'the verdict comes before the numbers');
    assert.ok(cardsAt < diagnosticsAt, 'diagnostics come last');
    assert.match(html, /Click Due Soon filter button/);
  });

  it('hides the machinery behind a collapsed Diagnostics section', () => {
    const html = renderReport(failing);
    // `<details>` with no `open` attribute: the reader has to ask for it.
    assert.match(html, /<details class="diagnostics">/);
    assert.ok(!/<details class="diagnostics" open>/.test(html));
    // Terms of art live in there, not in the headline chips.
    const headline = html.slice(html.indexOf('headline-cards'), html.indexOf('What the test did'));
    assert.ok(!/fast path|JIT heal|tokens used/.test(headline), 'no jargon in the headline chips');
  });

  it('links the verdict to the first failing step', () => {
    const html = renderReport(failing);
    assert.match(html, /href="#step-0"/);
    assert.match(html, /id="step-0"/);
  });

  it('tells the story of what was tried before dumping the raw error', () => {
    const html = renderReport(failing);
    const traceAt = html.indexOf('What was tried, in order');
    const rawAt = html.indexOf('Full error text');
    assert.ok(traceAt > 0 && rawAt > traceAt, 'prose first, raw evidence after');
  });

  it('explains every term of art it still shows', () => {
    // Any badge label the reporter can emit must have a plain-language
    // explanation — a new badge with no entry is the exact failure this
    // section exists to fix.
    const labelled = bundleOf((b) => {
      for (const resolution of ['case', 'cache', 'jit', 'dialog'] as const) {
        b.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution, status: 'passed', ...base });
      }
      b.addStep({ action: 'request', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
    });
    const html = renderReport(labelled);

    for (const match of html.matchAll(/<span class="badge res-[a-z]+">(?:<abbr title="([^"]*)">)?([^<]*)/g)) {
      const [, explanation, label] = match;
      assert.ok(
        explanation || GLOSSARY[label ?? ''],
        `badge "${label}" is shown with no glossary entry`,
      );
    }
  });

  it('does not badge the fast path — every ordinary step resolves that way', () => {
    const html = renderReport(
      bundleOf((b) => {
        b.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
      }),
    );
    assert.ok(!/badge res-fast/.test(html));
  });
});

describe('verdict — the failure shape decides the copy, not the header', () => {
  it('a content mismatch says the element was found, even wrapped in a resolve header', () => {
    // PB-05-01's live shape: expectText role=main resolved on every rung and
    // failed on TEXT, and the verdict said the control was never found —
    // sending a reader hunting a control that was on screen the whole time.
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'expectText',
        intent: 'Confirm case ID PB-001 exists on probation reviews list',
        selector: 'role=main',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error:
          'could not resolve "role=main" after 3 attempt(s):\n' +
          '  - fast "role=main": expected text to contain "PB-001", got "Probation Review…"',
      });
    });
    const verdict = buildVerdict(bundle);
    assert.match(verdict.what, /the element was found/);
    assert.doesNotMatch(verdict.what, /never found/);
  });

  it('a failed absence check says the element stayed, not that it was never found', () => {
    // The inversion: an expectHidden timeout means the element WAS there for
    // the whole window.
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'expectHidden',
        intent: 'Verify extended key does not appear raw',
        selector: 'text=extended',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'locator.waitFor: Timeout 2000ms exceeded.',
      });
    });
    const verdict = buildVerdict(bundle);
    assert.match(verdict.what, /expected to be absent was still on the page/);
    assert.doesNotMatch(verdict.what, /never found/);
  });

  it('a failing step on a sign-in page overrides the side copy with the stranded note', () => {
    // DB-04-01's live shape: every body step failed against /en/login and the
    // verdict said "FRONTEND problem … suggested owner: frontend" about an
    // app whose only act was redirecting an unauthenticated run.
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'click',
        intent: 'Open Create Plan modal',
        selector: 'role=button[name="Create Plan" i]',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        url: 'http://localhost:3200/en/login',
        error: 'could not resolve "role=button[name="Create Plan" i]" after 2 attempt(s):\n  - fast: Timeout',
      });
    });
    const verdict = buildVerdict(bundle);
    assert.match(verdict.side ?? '', /sign-in page/);
    assert.match(verdict.side ?? '', /fix the flow's sign-in/);
    assert.doesNotMatch(verdict.side ?? '', /FRONTEND problem/);
  });
});


/**
 * The agent deciding for itself when a run meets something the flow does not
 * describe (PB_01_01's PDPA "Accept and continue" screen — not an ARIA dialog,
 * so the modal rung is blind to it; not a pointer-interception, so the overlay
 * rung is too).
 *
 * `decisionFrom` is pure, so what the agent said and what is recorded can be
 * checked without a browser. The three rendering tests are the other half:
 * a decision nobody can read is a decision that was not recorded.
 */
describe('a decision the agent took on the reader\u2019s behalf', () => {
  const consentAction = {
    index: 0,
    action: 'click',
    selector: 'role=button[name="Accept and continue"]',
    value: null,
    url: 'http://app/x',
    reasoning: 'a PDPA consent screen is covering the page',
    ok: true,
    durationMs: 40,
  };
  const record = {
    goal: 'the test expected …',
    model: 'stub-agent',
    success: true,
    summary: 'accepted the consent screen so the page underneath could be reached',
    actions: [consentAction, { ...consentAction, index: 1, action: 'finish', selector: null, reasoning: 'done' }],
    turns: 2,
    maxSteps: 8,
    latencyMs: 900,
  };

  it('records what the agent judged, chose and did — in its own words', () => {
    const decision = decisionFrom(record, true);
    assert.equal(decision.observed, 'a PDPA consent screen is covering the page');
    assert.match(decision.decided, /^click role=button\[name="Accept and continue"\]/);
    assert.equal(decision.because, record.summary);
    assert.equal(decision.resolved, true);
    assert.equal(decision.model, 'stub-agent');
    assert.equal(decision.actions.length, 2, 'the acts are kept whole, finish included');
  });

  it('records a decision NOT to act, rather than recording nothing', () => {
    // "The agent looked and saw nothing in the way" and "the agent was never
    // consulted" are different facts about a dead-ended step, and only the
    // first one tells a reader the ladder was exhausted honestly.
    const declined = {
      ...record,
      success: false,
      summary: 'nothing is covering the page; the control simply is not present',
      actions: [{ ...consentAction, action: 'finish', selector: null, reasoning: 'nothing to do' }],
    };
    const decision = decisionFrom(declined, false);
    assert.equal(decision.observed, '', 'it claimed no sighting, so none is invented');
    assert.match(decision.decided, /nothing/);
    assert.equal(decision.resolved, false);
  });

  it('never synthesises words the agent did not say', () => {
    const silent = { ...record, summary: '', actions: [] };
    const decision = decisionFrom(silent, false);
    assert.equal(decision.observed, '');
    assert.equal(decision.because, '');
  });

  it('renders the decision, and separates the claim from the evidence', () => {
    const html = renderReport(
      bundleOf((b) => {
        b.addStep({
          action: 'click',
          intent: 'Open the probation record',
          selector: '#open',
          resolvedSelector: '#open',
          resolution: 'agent',
          status: 'passed',
          decision: decisionFrom(record, true),
          ...base,
        });
      }),
    );
    assert.match(html, /a PDPA consent screen is covering the page/, 'what it judged');
    assert.match(html, /Accept and continue/, 'what it chose');
    assert.match(html, /the flow does not describe/, 'named as an undescribed interaction');
    assert.match(html, /own selector then/, 'the evidence is stated apart from the claim');
  });

  it('shows nothing when no decision was taken', () => {
    // The assertion rail is structural — `#agentRescue` returns before the
    // agent is ever called for an `ASSERTION_ACTIONS` step, so no record
    // exists to derive a decision from. This is the visible half of it: a step
    // with no decision must not grow a block or a badge implying one.
    const html = renderReport(
      bundleOf((b) => {
        b.addStep({
          action: 'expectVisible',
          selector: '#open',
          resolvedSelector: null,
          resolution: null,
          status: 'failed',
          error: 'could not resolve',
          ...base,
        });
      }),
    );
    assert.ok(!/agent decided/.test(html));
    assert.ok(!/does not describe/.test(html));
  });

  it('explains the badge it adds', () => {
    const html = renderReport(
      bundleOf((b) => {
        b.addStep({
          action: 'click',
          selector: '#open',
          resolvedSelector: '#open',
          resolution: 'agent',
          status: 'passed',
          decision: decisionFrom(record, true),
          ...base,
        });
      }),
    );
    for (const match of html.matchAll(/<span class="badge res-[a-z]+">(?:<abbr title="([^"]*)">)?([^<]*)/g)) {
      const [, explanation, label] = match;
      assert.ok(explanation || GLOSSARY[label ?? ''], `badge "${label}" has no glossary entry`);
    }
    assert.ok(GLOSSARY['agent decided'], 'the new badge is explained');
  });

  it('tells a failing step\u2019s reader that a decision was taken for them', () => {
    const bundle = bundleOf((b) => {
      b.addStep({
        action: 'click',
        intent: 'Open the probation record',
        selector: '#open',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        error: 'could not resolve "#open" after 3 attempt(s):\n  - fast: timeout',
        decision: decisionFrom({ ...record, success: false }, false),
        ...base,
      });
    });
    // Through buildVerdict: describeStep only NAMES the step, the account of
    // what broke is the verdict's `what`.
    const prose = buildVerdict(bundle).what;
    assert.match(prose, /does not describe/);
    assert.match(prose, /PDPA consent screen/);
  });
});
