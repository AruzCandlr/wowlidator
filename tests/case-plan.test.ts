/**
 * Suite scheduling: what may run beside what.
 *
 * All unit tier — the classification is a walk over a flow's steps and the
 * pool is promise bookkeeping, so neither needs a browser or a model. The
 * ordering assertions matter more than they look: a scheduler that merely
 * *usually* keeps a writer alone is a scheduler that produces a flaky suite on
 * a faster machine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CaseQueue, DEFAULT_AUTHOR_CONCURRENCY, ScenarioGate, authorWorkers, caseWrites, mapPool, orderScenariosFastestFirst, planCases, readersFirst, runQueue, runWithConcurrency, withWorkflowScripts } from '../src/cli/case-plan.js';
import { signsInItself, type Flow } from '../src/engine/runner.js';

const flow = (steps: Flow['steps'], setup?: Flow['setup']): Flow =>
  ({ name: 'f', steps, ...(setup ? { setup } : {}) }) as Flow;

describe('readersFirst', () => {
  const reader = (name: string) => ({
    name,
    flow: flow([{ action: 'expectVisible', selector: 'text=x' }] as Flow['steps']),
  });
  const writer = (name: string) => ({
    name,
    flow: flow([
      { action: 'fill', selector: 'role=textbox[name="Plan" i]', value: 'v' },
    ] as Flow['steps']),
  });

  it('moves every reader in front of the first writer, both sides stable', () => {
    const ordered = readersFirst([writer('w1'), reader('r1'), writer('w2'), reader('r2')]);
    assert.deepEqual(
      ordered.map((c) => c.name),
      ['r1', 'r2', 'w1', 'w2'],
    );
  });

  it('an all-reader or all-writer list is returned untouched, same reference', () => {
    const readers = [reader('a'), reader('b')];
    const writers = [writer('a'), writer('b')];
    assert.equal(readersFirst(readers), readers);
    assert.equal(readersFirst(writers), writers);
  });
});

describe('caseWrites', () => {
  it('a read-only case is a reader', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'goto', url: 'http://x.test/en/queue' },
          { action: 'expectVisible', selector: 'role=heading[name="Queue" i]' },
          { action: 'expectText', selector: 'body', text: 'Somchai' },
        ] as Flow['steps']),
      ),
      false,
    );
  });

  // The rule the whole feature depends on: every catalog case logs in, so
  // counting a sign-in as a write would make every case exclusive and the
  // pool would never hold more than one.
  it('signing in is not a write', () => {
    assert.equal(
      caseWrites(
        flow(
          [{ action: 'expectVisible', selector: 'role=heading[name="Queue" i]' }] as Flow['steps'],
          [
            { action: 'goto', url: 'http://x.test/en/login' },
            { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
            { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
            { action: 'click', selector: 'role=button[name="Sign in" i]' },
          ] as Flow['setup'],
        ),
      ),
      false,
    );
  });

  it('a workflow leg that only signs in is not a write', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'goto', url: 'http://x.test/en/login' },
          { action: 'workflow', goal: 'Enter password hrbp2026, click Sign in, accept PDPA consent' },
          { action: 'expectVisible', selector: 'role=heading[name="Queue" i]' },
        ] as Flow['steps']),
      ),
      false,
    );
  });

  it('a workflow leg that only navigates is a reader', () => {
    // The live catalog: five of six cases were serialised for goals like this
    // one, and every one of them only opened a page.
    assert.equal(
      caseWrites(
        flow([
          { action: 'workflow', goal: 'navigate via Sidebar -> Team -> Probation Reviews and end on /en/workflows/probation' },
          { action: 'expectVisible', selector: 'text="Urgent"' },
        ] as Flow['steps']),
      ),
      false,
    );
    assert.equal(
      caseWrites(
        flow([
          { action: 'workflow', goal: 'Open cases PB-001 through PB-007 one at a time and read each status' },
          { action: 'expectHidden', selector: 'text="pending_hr"' },
        ] as Flow['steps']),
      ),
      false,
    );
  });

  it('a workflow leg that does anything else is a write', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'workflow', goal: 'Open PB-001 and approve the probation review' },
        ] as Flow['steps']),
      ),
      true,
    );
  });

  it('filling a form that is not the login is a write', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'goto', url: 'http://x.test/en/rules/new' },
          { action: 'fill', selector: 'role=textbox[name="Rule name" i]', value: 'RULE-1' },
          { action: 'click', selector: 'role=button[name="Save" i]' },
        ] as Flow['steps']),
      ),
      true,
    );
  });

  it('a non-GET request is a write; a GET is not', () => {
    const req = (method: string) =>
      caseWrites(flow([{ action: 'request', method, url: '/api/x' }] as unknown as Flow['steps']));
    assert.equal(req('POST'), true);
    assert.equal(req('DELETE'), true);
    assert.equal(req('GET'), false);
    assert.equal(req('HEAD'), false);
  });

  it('any database assertion makes the case exclusive', () => {
    assert.equal(
      caseWrites(flow([{ action: 'expectDbRow', table: 't', where: {} }] as unknown as Flow['steps'])),
      true,
    );
  });

  it('storage seeding is not a write — the context is this run alone', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'goto', url: 'http://x.test/en/login' },
          { action: 'clearStorage' },
          { action: 'expectVisible', selector: 'role=heading' },
        ] as unknown as Flow['steps']),
      ),
      false,
    );
  });
});

describe('the auth exemption reads the page, not the field name', () => {
  // The bug this replaced: matching `email|password|username` in a selector
  // called "Manager email" on a business form a login, and let that case run
  // beside others while it wrote.
  it('a business form with an email field is still a write', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'goto', url: 'http://x.test/en/employees/new' },
          { action: 'fill', selector: 'role=textbox[name="Manager email" i]', value: 'm@b.test' },
          { action: 'click', selector: 'role=button[name="Save" i]' },
        ] as Flow['steps']),
      ),
      true,
    );
  });

  it('an unnamed password field on the sign-in page is still auth', () => {
    assert.equal(
      caseWrites(
        flow([
          { action: 'goto', url: 'http://x.test/en/login' },
          { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
          { action: 'click', selector: 'role=button[name="Sign in" i]' },
          { action: 'expectVisible', selector: 'role=heading' },
        ] as Flow['steps']),
      ),
      false,
    );
  });

  it('errs toward a writer when there is no goto to read', () => {
    assert.equal(
      caseWrites(flow([{ action: 'fill', selector: 'role=textbox', value: 'x' }] as Flow['steps'])),
      true,
    );
  });
});

describe('authorWorkers', () => {
  it('reads the Machinery dial when no flag is given; the flag and a serial provider still win', () => {
    assert.equal(authorWorkers(undefined, 'groq', { WOWLIDATOR_AUTHOR_CONCURRENCY: '5' }), 5);
    assert.equal(authorWorkers(2, 'groq', { WOWLIDATOR_AUTHOR_CONCURRENCY: '5' }), 2, 'the flag wins');
    assert.equal(authorWorkers(undefined, 'local', { WOWLIDATOR_AUTHOR_CONCURRENCY: '5' }), 1, 'serial provider stays 1');
    assert.equal(authorWorkers(undefined, 'groq', { WOWLIDATOR_AUTHOR_CONCURRENCY: '99' }), DEFAULT_AUTHOR_CONCURRENCY, 'out of range falls back');
  });

  it('authors one row at a time on a provider that answers one call at a time', () => {
    assert.equal(authorWorkers(undefined, 'local'), 1);
    assert.equal(authorWorkers(undefined, 'groq'), DEFAULT_AUTHOR_CONCURRENCY);
  });

  it('an explicit --author-concurrency always wins, floored at 1', () => {
    assert.equal(authorWorkers(3, 'local'), 3);
    assert.equal(authorWorkers(0, 'groq'), 1);
  });
});

describe('planCases', () => {
  it('keeps the listed order and marks each one', () => {
    const plan = planCases([
      { name: 'reads', flow: flow([{ action: 'expectVisible', selector: 'x' }] as Flow['steps']) },
      { name: 'writes', flow: flow([{ action: 'expectDbRow', table: 't' }] as unknown as Flow['steps']) },
    ]);
    assert.deepEqual(plan.map((c) => [c.index, c.name, c.exclusive]), [
      [0, 'reads', false],
      [1, 'writes', true],
    ]);
  });
});

describe('runWithConcurrency', () => {
  /** A run that records when it was in flight, so overlap is observable. */
  function tracker() {
    let live = 0;
    const peak: number[] = [];
    const overlappedWith: Record<string, number> = {};
    return {
      peak,
      overlappedWith,
      async run(item: { id: string; ms: number }) {
        live += 1;
        peak.push(live);
        overlappedWith[item.id] = live;
        await new Promise((r) => setTimeout(r, item.ms));
        live -= 1;
      },
    };
  }

  it('never exceeds the limit', async () => {
    const t = tracker();
    const items = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, ms: 12 }));
    await runWithConcurrency(items, 4, () => false, t.run);
    assert.equal(Math.max(...t.peak), 4);
  });

  it('runs an exclusive item with nothing else in flight', async () => {
    const t = tracker();
    const items = [
      { id: 'r0', ms: 25 },
      { id: 'r1', ms: 25 },
      { id: 'w', ms: 5 },
      { id: 'r2', ms: 25 },
      { id: 'r3', ms: 25 },
    ];
    await runWithConcurrency(items, 4, (i) => i.id === 'w', t.run);
    assert.equal(t.overlappedWith['w'], 1, 'the writer must be the only thing running');
  });

  it('concurrency 1 is the sequential run, exactly', async () => {
    const t = tracker();
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, ms: 4 }));
    await runWithConcurrency(items, 1, () => false, t.run);
    assert.equal(Math.max(...t.peak), 1);
  });

  it('starts items in the listed order', async () => {
    const started: string[] = [];
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}` }));
    await runWithConcurrency(items, 3, () => false, async (item) => {
      started.push(item.id);
      await new Promise((r) => setTimeout(r, 5));
    });
    assert.deepEqual(started, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('waits for everything, including the last partial batch', async () => {
    let done = 0;
    await runWithConcurrency(
      Array.from({ length: 7 }, (_, i) => i),
      4,
      () => false,
      async () => {
        await new Promise((r) => setTimeout(r, 6));
        done += 1;
      },
    );
    assert.equal(done, 7);
  });
});

describe('CaseQueue / runQueue — cases that arrive while others run', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  it('runs an item pushed after the scheduler started, and returns only after close', async () => {
    const queue = new CaseQueue<string>();
    const ran: string[] = [];
    let done = false;
    const draining = runQueue(queue, 4, () => false, async (item) => { ran.push(item); }).then(() => { done = true; });
    queue.push('a');
    await tick();
    assert.deepEqual(ran, ['a'], 'started before anything else arrived');
    assert.equal(done, false, 'an open queue is not drained');
    queue.push('b');
    await tick();
    assert.deepEqual(ran, ['a', 'b']);
    queue.close();
    await draining;
    assert.equal(done, true);
  });

  it('a pause stops new dispatch while in-flight items finish with results', async () => {
    // The shouldPause seam's contract: no NEW dispatch once raised. Since the
    // instant-pause change this seam is the backstop (a ledgered suite exits
    // on the spot from `onPause` instead) and the whole behaviour for a suite
    // with no ledger, where in-flight cases still finish with verdicts.
    const queue = new CaseQueue<string>();
    ['a', 'b', 'c', 'd'].forEach((x) => queue.push(x));
    queue.close();
    const ran: string[] = [];
    let paused = false;
    await runQueue(
      queue,
      1,
      () => false,
      async (item) => {
        ran.push(item);
        if (item === 'b') paused = true; // the pause arrives while b runs
      },
      () => paused,
    );
    // a and b ran to completion; c and d were never taken.
    assert.deepEqual(ran, ['a', 'b']);
  });

  it('indexes by arrival and keeps that order for starts', async () => {
    const queue = new CaseQueue<string>();
    assert.equal(queue.push('x'), 0);
    assert.equal(queue.push('y'), 1);
    queue.close();
    const seen: [string, number][] = [];
    await runQueue(queue, 3, () => false, async (item, i) => { seen.push([item, i]); });
    assert.deepEqual(seen, [['x', 0], ['y', 1]]);
  });

  it('an exclusive item that arrives mid-run waits for the pool to drain and runs alone', async () => {
    const queue = new CaseQueue<string>();
    let inFlight = 0;
    const peaks: Record<string, number> = {};
    const release: Record<string, () => void> = {};
    const gate = (id: string): Promise<void> => new Promise((r) => { release[id] = r; });
    const draining = runQueue(queue, 4, (i) => i === 'w', async (item) => {
      inFlight += 1;
      peaks[item] = inFlight;
      await gate(item);
      inFlight -= 1;
    });
    queue.push('r1'); queue.push('r2');
    await tick();
    queue.push('w');
    await tick();
    assert.equal(peaks['w'], undefined, 'the writer waits while readers are in flight');
    release['r1']!(); release['r2']!();
    await tick();
    assert.equal(peaks['w'], 1, 'and then runs with nothing beside it');
    queue.push('r3');
    await tick();
    assert.equal(peaks['r3'], undefined, 'nothing starts beside the writer');
    release['w']!();
    await tick();
    assert.equal(peaks['r3'], 1);
    release['r3']!();
    queue.close();
    await draining;
  });

  it('an empty, closed queue drains at once; push after close is refused', async () => {
    const queue = new CaseQueue<string>();
    queue.close();
    await runQueue(queue, 2, () => false, async () => {});
    assert.throws(() => queue.push('late'));
  });
});

describe('mapPool — rows authored side by side', () => {
  it('never exceeds the worker count, hands each worker a fixed slot, and starts in order', async () => {
    let inFlight = 0, peak = 0;
    const starts: number[] = [];
    const slots = new Set<number>();
    await mapPool([10, 20, 30, 40, 50], 2, async (_item, index, slot) => {
      starts.push(index); slots.add(slot);
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight -= 1;
    });
    assert.equal(peak, 2);
    assert.deepEqual(starts, [0, 1, 2, 3, 4]);
    assert.deepEqual([...slots].sort(), [0, 1]);
  });

  it('one worker is the sequential loop; more workers than items is capped', async () => {
    const seen: number[] = [];
    await mapPool(['a', 'b'], 1, async (_i, index) => { seen.push(index); });
    assert.deepEqual(seen, [0, 1]);
    const slotsSeen = new Set<number>();
    await mapPool(['a', 'b'], 8, async (_i, _index, slot) => { slotsSeen.add(slot); });
    assert.ok([...slotsSeen].every((s) => s < 2));
  });

  it('rethrows a worker failure', async () => {
    await assert.rejects(mapPool([1, 2], 2, async (i) => { if (i === 2) throw new Error('boom'); }), /boom/);
  });
});

describe('signsInItself', () => {
  // Decides whether a run starts with the browser's session or empty. A flow
  // that types a password wants to be the account it types.
  it('sees a password field, by selector or by intent', () => {
    assert.equal(
      signsInItself(flow([{ action: 'fill', selector: 'input[type="password"]', value: 'x' }] as Flow['steps'])),
      true,
    );
    assert.equal(
      signsInItself(
        flow([{ action: 'fill', selector: 'role=textbox >> nth=1', value: 'x', intent: 'Enter the password' }] as Flow['steps']),
      ),
      true,
    );
  });

  it('sees the taught nameless-textbox idiom on a sign-in page, and only there', () => {
    assert.equal(
      signsInItself(
        flow([
          { action: 'goto', url: 'http://x.test/en/login' },
          { action: 'fill', selector: 'role=textbox >> nth=1', value: 'x' },
        ] as Flow['steps']),
      ),
      true,
    );
    assert.equal(
      signsInItself(
        flow([
          { action: 'goto', url: 'http://x.test/en/employees/new' },
          { action: 'fill', selector: 'role=textbox >> nth=1', value: 'x' },
        ] as Flow['steps']),
      ),
      false,
    );
  });

  it('is false for a flow that never authenticates', () => {
    assert.equal(
      signsInItself(flow([{ action: 'goto', url: 'http://x.test/en/queue' }, { action: 'expectVisible', selector: 'role=heading' }] as Flow['steps'])),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// ScenarioGate — authoring holds to the scenario the runner is in.
// Unit tier: the gate is counter bookkeeping; nothing here needs a browser.
// The tiny pollMs keeps the pause test honest without slowing the suite.
// ---------------------------------------------------------------------------

describe('ScenarioGate', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('allows the first scenario at once and holds the second', () => {
    const gate = new ScenarioGate(['PL_01', 'PL_01', 'PL_02'], { pollMs: 2 });
    assert.equal(gate.allowed('PL_01'), true);
    assert.equal(gate.allowed('PL_02'), false);
  });

  it('clears a scenario only when authored rows AND queued runs are done', async () => {
    const gate = new ScenarioGate(['PL_01', 'PL_01', 'PL_02'], { pollMs: 2 });
    gate.authored('PL_01');
    gate.queued('PL_01');
    gate.authored('PL_01');
    gate.queued('PL_01');
    // Both rows authored, both queued, none run yet: PL_02 still waits.
    assert.equal(gate.allowed('PL_02'), false);
    gate.ran('PL_01');
    assert.equal(gate.allowed('PL_02'), false);
    gate.ran('PL_01');
    assert.equal(gate.allowed('PL_02'), true);
    await gate.waitFor('PL_02'); // resolves immediately now
  });

  it('a refused row still clears its scenario', () => {
    const gate = new ScenarioGate(['PL_01', 'PL_02'], { pollMs: 2 });
    gate.authored('PL_01'); // refused: authored ticks, nothing queued
    assert.equal(gate.allowed('PL_02'), true);
  });

  it('waitFor blocks until the scenario clears, then releases', async () => {
    const gate = new ScenarioGate(['PL_01', 'PL_02'], { pollMs: 2 });
    let released = false;
    const waiting = gate.waitFor('PL_02').then(() => {
      released = true;
    });
    await tick();
    assert.equal(released, false);
    gate.authored('PL_01');
    await waiting;
    assert.equal(released, true);
  });

  it('waitFor gives up when shouldStop says so — the pause contract', async () => {
    const gate = new ScenarioGate(['PL_01', 'PL_02'], { pollMs: 2 });
    let stop = false;
    const waiting = gate.waitFor('PL_02', () => stop);
    await tick();
    stop = true;
    await waiting; // resolves via the poll, with PL_01 never cleared
    assert.equal(gate.allowed('PL_02'), false);
  });

  it('lookahead widens the window; Infinity never holds anything', () => {
    const one = new ScenarioGate(['PL_01', 'PL_02', 'PL_03'], { lookahead: 1, pollMs: 2 });
    assert.equal(one.allowed('PL_02'), true);
    assert.equal(one.allowed('PL_03'), false);
    const all = new ScenarioGate(['PL_01', 'PL_02', 'PL_03'], { lookahead: Infinity, pollMs: 2 });
    assert.equal(all.allowed('PL_03'), true);
  });

  it('a scenario the plan never named is never held', () => {
    const gate = new ScenarioGate(['PL_01'], { pollMs: 2 });
    assert.equal(gate.allowed('ungrouped'), true);
  });
});

// ---------------------------------------------------------------------------
// runQueue with a growing limit — the pipelined 3→5 ramp.
// ---------------------------------------------------------------------------

describe('runQueue with a callback concurrency', () => {
  it('re-reads the limit before each dispatch, so the pool can widen mid-run', async () => {
    const queue = new CaseQueue<number>();
    for (let i = 0; i < 8; i += 1) queue.push(i);
    queue.close();

    let limit = 2;
    let inFlight = 0;
    let peakAtTwo = 0;
    let peakAtFive = 0;
    const gates: (() => void)[] = [];
    const done = runQueue(
      queue,
      () => limit,
      () => false,
      async () => {
        inFlight += 1;
        if (limit === 2) peakAtTwo = Math.max(peakAtTwo, inFlight);
        else peakAtFive = Math.max(peakAtFive, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight -= 1;
      },
    );

    // Let the first wave start, prove it is capped at 2, then widen to 5.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(peakAtTwo, 2);
    limit = 5;
    // Release everything as it arrives until the queue drains.
    const drain = setInterval(() => {
      while (gates.length > 0) gates.pop()!();
    }, 2);
    await done;
    clearInterval(drain);
    assert.ok(peakAtFive >= 3, `pool never widened past 2 (peak ${peakAtFive})`);
    assert.ok(peakAtFive <= 5, `pool exceeded the widened limit (peak ${peakAtFive})`);
  });
});

// ---------------------------------------------------------------------------
// withWorkflowScripts — a successful agent journey becomes the flow's own
// deterministic script; anything else leaves the flow byte-identical.
// ---------------------------------------------------------------------------

describe('withWorkflowScripts', () => {
  const action = (over: Partial<Record<string, unknown>> = {}) => ({
    index: 0,
    action: 'click',
    selector: 'role=link[name="Benefit Plans" i]',
    value: null,
    url: 'http://x.test/en/admin/benefits/plans',
    reasoning: 'r',
    ok: true,
    durationMs: 10,
    ...over,
  });
  const record = (goal: string, over: Partial<Record<string, unknown>> = {}) =>
    ({
      goal,
      model: 'stub',
      success: true,
      summary: 's',
      actions: [
        action(),
        action({ index: 1, action: 'finish', selector: null }),
      ],
      turns: 2,
      maxSteps: null,
      latencyMs: 1,
      ...over,
    }) as never;

  it('records the successful journey on the matching workflow step, minus finish/fail/wait', () => {
    const f = flow([
      { action: 'workflow', goal: 'Open the Benefit Plans page, ending on /en/admin/benefits/plans' },
    ] as Flow['steps']);
    const out = withWorkflowScripts(f, [record('Open the Benefit Plans page, ending on /en/admin/benefits/plans')]);
    assert.notEqual(out, null);
    const step = out!.steps[0] as { action: string; script?: { action: string; selector: string }[] };
    assert.equal(step.action, 'workflow');
    assert.equal(step.script!.length, 1);
    assert.equal(step.script![0]!.action, 'click');
    // The input flow object is untouched — the caller decides what to write.
    assert.equal((f.steps[0] as { script?: unknown }).script, undefined);
  });

  it('returns null when nothing changed: failed record, unmatched goal, or same script already present', () => {
    const goal = 'Open the page';
    const f = flow([{ action: 'workflow', goal }] as Flow['steps']);
    assert.equal(withWorkflowScripts(f, [record(goal, { success: false })]), null);
    assert.equal(withWorkflowScripts(f, [record('a different goal')]), null);
    const once = withWorkflowScripts(f, [record(goal)]);
    assert.equal(withWorkflowScripts(once!, [record(goal)]), null);
  });

  it('reaches workflow steps inside when branches and in setup', () => {
    const goal = 'Clear the consent gate';
    const f = {
      name: 'f',
      setup: [{ action: 'workflow', goal }],
      steps: [
        {
          action: 'when',
          selector: 'role=button[name="Accept" i]',
          condition: 'visible',
          then: [{ action: 'workflow', goal }],
        },
      ],
    } as unknown as Flow;
    const out = withWorkflowScripts(f, [record(goal)]);
    assert.notEqual(out, null);
    const setupStep = out!.setup![0] as { script?: unknown[] };
    const branchStep = (out!.steps[0] as { then: { script?: unknown[] }[] }).then[0]!;
    assert.equal(setupStep.script!.length, 1);
    assert.equal(branchStep.script!.length, 1);
  });
});

describe('orderScenariosFastestFirst', () => {
  const row = (caseId: string, scenarioId: string, steps: string, extra: Partial<{ testCase: string; expected: string }> = {}) =>
    ({ caseId, scenarioId, steps, ...extra });

  it('queues the statically cheaper scenario first, rows contiguous and in sheet order', () => {
    const rows = [
      row('A_01', 'A', '1. a\n2. b\n3. c\n4. d\n5. e'),
      row('A_02', 'A', '1. a\n2. b\n3. c'),
      row('B_01', 'B', '1. a'),
    ];
    const { rows: ordered, order } = orderScenariosFastestFirst(rows);
    assert.deepEqual(ordered.map((r) => r.caseId), ['B_01', 'A_01', 'A_02']);
    assert.deepEqual(order.map((o) => o.scenario), ['B', 'A']);
    assert.equal(order[0]!.rows, 1);
  });

  it('a recorded duration outranks the static estimate', () => {
    const rows = [
      row('A_01', 'A', '1. a'),                 // static: tiny
      row('B_01', 'B', '1. a\n2. b\n3. c\n4. d'), // static: bigger
    ];
    // History says A was actually the slow one (an agent leg, say).
    const prior = new Map([['A_01', 300_000], ['B_01', 5_000]]);
    const { rows: ordered } = orderScenariosFastestFirst(rows, prior);
    assert.deepEqual(ordered.map((r) => r.caseId), ['B_01', 'A_01']);
  });

  it('a writer is priced above its line count — it will run alone', () => {
    const reader = row('R_01', 'R', '1. open the list\n2. read the count');
    const writer = row('W_01', 'W', '1. open the list\n2. delete the row');
    const { order } = orderScenariosFastestFirst([writer, reader]);
    assert.deepEqual(order.map((o) => o.scenario), ['R', 'W']);
  });

  it('ties break to sheet order, and every row survives', () => {
    const rows = [
      row('B_01', 'B', '1. a'),
      row('A_01', 'A', '1. a'),
      row('C_01', '', '1. a'),
    ];
    const { rows: ordered, order } = orderScenariosFastestFirst(rows);
    assert.equal(ordered.length, 3);
    assert.deepEqual(order.map((o) => o.scenario), ['B', 'A', 'ungrouped']);
  });
});
