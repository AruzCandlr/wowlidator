/**
 * The workflow agent's deterministic guards — what is checked before a
 * decision is acted on, and what the model is shown.
 *
 * The pure guards (`agent-guards.ts`) run always. The loop behaviours — a
 * refused finish, a stall, a fast-failed miss, the origin guard — are
 * browser-tier: each is a fact about a loop driving a real page with a
 * scripted model, and every one of them was invisible to a pure assertion
 * about the predicate alone. Same CDP gate as the other browser suites.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  decisionKey,
  focusTree,
  selectorGrounded,
  selectorName,
  goalAlreadyShowing,
  goalSurfaceNames,
  unscopedDestructiveClick,
} from '../src/orchestrator/agent-guards.js';
import { AGENT_ACTIONS, AGENT_NO_PROGRESS_TURNS, WorkflowAgent, parseWherePairs, type AgentDecision, type AgentObservation } from '../src/orchestrator/workflow-agent.js';
import { withPage } from '../src/engine/runner.js';
import type { AxNode } from '../src/healer/jit-healer.js';

const TREE = `RootWebArea "Queue" url="http://x.test/en/queue"
heading "Probation Reviews"
button "Team"
link "Probation Reviews" url="http://x.test/en/workflows/probation"
textbox "Work email" value="a@b.test"
button "Next"
cell "Somchai Sukjai EMP042"`;

describe('selectorGrounded', () => {
  it('reads the name a role or text selector asks for', () => {
    assert.equal(selectorName('role=button[name="Next" i]'), 'Next');
    assert.equal(selectorName("role=link[name='Probation Reviews']"), 'Probation Reviews');
    assert.equal(selectorName('text="EMP042"'), 'EMP042');
    assert.equal(selectorName('text=EMP042'), 'EMP042');
    assert.equal(selectorName('input[type="password"]'), null, 'CSS names nothing the tree could contradict');
    assert.equal(selectorName('role=textbox >> nth=1'), null);
  });

  it('accepts a name the tree shows, whatever its case, and a longer tree name', () => {
    assert.equal(selectorGrounded('role=button[name="next" i]', TREE), true);
    assert.equal(selectorGrounded('role=cell[name="Somchai Sukjai"]', TREE), true, 'the tree name is longer');
    assert.equal(selectorGrounded('text="EMP042"', TREE), true);
  });

  it('refuses a name made of words the tree never shows', () => {
    assert.equal(selectorGrounded('role=button[name="Create Plan" i]', TREE), false);
    assert.equal(selectorGrounded('role=button[name="HRIS ADMIN" i]', TREE), false);
  });

  it('says nothing about a selector it cannot read', () => {
    assert.equal(selectorGrounded('input[type="password"]', TREE), null);
    assert.equal(selectorGrounded('role=textbox >> nth=1', TREE), null);
  });
});

describe('goalAlreadyShowing', () => {
  const node = (role: string, name: string): AxNode => ({
    role, name, value: '', description: '', disabled: false, checked: false, url: '',
  });

  it("reads the surface a goal says should be showing, in the shapes catalogs actually write", () => {
    // Verbatim from the be100 run of 2026-08-26.
    assert.deepEqual(
      goalSurfaceNames('On /en/admin/benefits/plans click the Create Plan button so the Create Plan dialog opens'),
      ['Create Plan'],
    );
    assert.deepEqual(
      goalSurfaceNames('select one plan and click its Insert action so that the popup titled "Insert New Changes for Benefit" opens'),
      ['Insert New Changes for Benefit'],
    );
    // A placeholder the author left in names nothing.
    assert.deepEqual(goalSurfaceNames('the popup titled "Insert New Changes for Benefit: <plan name>" opens'), []);
    // Most goals name no surface at all, and must fall through untouched.
    assert.deepEqual(goalSurfaceNames('count every plan whose Benefit Type is Reimbursement'), []);
  });

  it('says the leg is done when that surface is already open', () => {
    // Six of ten agent runs in one pass ended after one or two turns having
    // discovered exactly this — the authored step before them had opened it.
    const nodes = [node('heading', 'Benefit Plan Catalog'), node('dialog', 'Create Benefit Plan')];
    assert.equal(
      goalAlreadyShowing('click the Create Plan button so the Create Plan dialog opens', nodes),
      'Create Benefit Plan',
    );
  });

  it('says nothing whenever the evidence is short of unambiguous', () => {
    // The cost of a false yes is a leg that never ran, which is far worse
    // than a leg that ran needlessly — so every uncertain case falls through.
    const noDialog = [node('heading', 'Create Benefit Plan'), node('button', 'Create Plan')];
    assert.equal(goalAlreadyShowing('click Create Plan so the Create Plan dialog opens', noDialog), null,
      'a heading is not an open dialog');
    const otherDialog = [node('dialog', 'Confirm delete plan')];
    assert.equal(goalAlreadyShowing('click Create Plan so the Create Plan dialog opens', otherDialog), null,
      'a different dialog is not this one');
    assert.equal(goalAlreadyShowing('reach the reporting screen', [node('dialog', 'Anything')]), null,
      'a goal that names no surface never fires');
  });
});

describe('unscopedDestructiveClick', () => {
  const goal = 'delete the plan PL_03_15_16_17_18 and confirm';
  const click = (selector: string) => ({ action: 'click', selector, value: '', url: '' });

  it('refuses "the first Delete button" when the goal names a row', () => {
    // be100 PL_03_18: this exact selector deleted TH_MED_001, a plan the goal
    // never named, and the reasoning said it was the right row.
    const why = unscopedDestructiveClick(click('role=button[name="Delete" i] >> nth=0'), goal);
    assert.match(why ?? '', /^destructive:/);
    assert.match(why ?? '', /PL_03_15_16_17_18/);
    assert.match(why ?? '', /role=row\[name="PL_03_15_16_17_18" i\]/, 'the feedback shows the scoped shape');
    assert.match(unscopedDestructiveClick(click('role=button[name="Remove" i]'), 'remove TH_MED_001') ?? '', /^destructive/);
  });

  it('accepts a delete scoped to the goal\'s row, and a confirmation inside a dialog', () => {
    assert.equal(unscopedDestructiveClick(click('role=row[name="PL_03_15_16_17_18" i] >> role=button[name="Delete" i]'), goal), null);
    assert.equal(unscopedDestructiveClick(click('text=PL_03_15_16_17_18 >> .. >> role=button[name="Delete"]'), goal), null);
    assert.equal(unscopedDestructiveClick(click('role=dialog[name="Confirm delete plan" i] >> role=button[name="Delete"]'), goal), null);
  });

  it('leaves non-destructive clicks, and goals that name no identifier, to the prompt', () => {
    assert.equal(unscopedDestructiveClick(click('role=button[name="Edit" i] >> nth=0'), goal), null);
    assert.equal(unscopedDestructiveClick(click('role=button[name="Delete" i] >> nth=0'), 'delete the first draft'), null);
    assert.equal(unscopedDestructiveClick({ action: 'fill', selector: 'role=textbox[name="Delete reason"]', value: 'x', url: '' }, goal), null);
  });
});

describe('decisionKey', () => {
  it('is the same for the same action, selector, value and url — and nothing else', () => {
    const a = { action: 'fill', selector: 'input[type="password"]', value: 'pw', url: '' };
    assert.equal(decisionKey(a), decisionKey({ ...a, selector: ' input[type="password"] ' }));
    assert.notEqual(decisionKey(a), decisionKey({ ...a, value: 'other' }));
    assert.notEqual(decisionKey(a), decisionKey({ ...a, action: 'click' }));
  });
});

describe('focusTree', () => {
  const node = (role: string, name: string): AxNode => ({
    role, name, value: '', description: '', disabled: false, checked: false, url: '',
  });
  it('keeps the nodes the goal names inside the budget, in document order', () => {
    const nodes: AxNode[] = [
      ...Array.from({ length: 50 }, (_, i) => node('button', `Unrelated ${i}`)),
      node('link', 'Probation Reviews'),
      ...Array.from({ length: 50 }, (_, i) => node('StaticText', `Filler ${i}`)),
      node('button', 'Review'),
    ];
    const kept = focusTree(nodes, 'open Probation Reviews and click Review', 20);
    assert.equal(kept.length, 20);
    assert.ok(kept.some((n) => n.name === 'Probation Reviews'), 'the goal\'s link survives the cut');
    assert.ok(kept.some((n) => n.name === 'Review'), 'and so does the goal\'s button');
    // Document order is restored: the link (index 50) comes before the button (index 101).
    assert.ok(kept.findIndex((n) => n.name === 'Probation Reviews') < kept.findIndex((n) => n.name === 'Review'));
  });

  it("keeps the goal's own NUMBER, and the value beside the label it matched", () => {
    // be100 PL_03_01 (2026-08-25): "verify the Total Plans summary card shows
    // count 75" against a 345-node page. "75" is two characters, so the old
    // `length > 2` filter dropped the one term that named the answer; the
    // node called "75" scored zero and lost its place to sixty sidebar links.
    // The agent was shown the LABEL with the value removed, spent five turns
    // scrolling for it, and the next step's expectText "75" passed.
    const nodes: AxNode[] = [
      ...Array.from({ length: 40 }, (_, i) => node('link', `Sidebar ${i}`)),
      node('StaticText', 'TOTAL PLANS'),
      node('StaticText', '75'),
      ...Array.from({ length: 40 }, (_, i) => node('button', `Row action ${i}`)),
    ];
    const kept = focusTree(nodes, 'verify the Total Plans summary card shows count 75', 12);
    const names = kept.map((n) => n.name);
    assert.ok(names.includes('TOTAL PLANS'), 'the label the goal names');
    assert.ok(names.includes('75'), 'and the count, which is the whole answer');
    assert.ok(names.indexOf('TOTAL PLANS') < names.indexOf('75'), 'in document order');
  });

  it('carries a matched label\'s neighbour even when the value shares no goal term', () => {
    // A summary card is a label and a value as siblings, and the value is
    // frequently a number the goal does not state. Keeping the label and
    // cutting the number is the same failure with none of the evidence.
    const nodes: AxNode[] = [
      ...Array.from({ length: 30 }, (_, i) => node('link', `Noise ${i}`)),
      node('StaticText', 'REIMBURSEMENT BY HR'),
      node('StaticText', '4'),
      ...Array.from({ length: 30 }, (_, i) => node('button', `Action ${i}`)),
    ];
    const kept = focusTree(nodes, 'read the Reimbursement by HR card', 10).map((n) => n.name);
    assert.ok(kept.includes('REIMBURSEMENT BY HR'));
    assert.ok(kept.includes('4'), 'the neighbour rides in on the match');
  });

  it('returns everything untouched when it fits', () => {
    const nodes = [node('button', 'A'), node('link', 'B')];
    assert.deepEqual(focusTree(nodes, 'anything', 10), nodes);
  });
});

// --- the loop, against a real page -------------------------------------------

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

/** A model that answers from a script, and records what it was asked. */
function scripted(answers: Array<Partial<AgentDecision> & { action: AgentDecision['action'] }>) {
  const seen: AgentObservation[] = [];
  let i = 0;
  return {
    seen,
    model: {
      id: 'stub:scripted',
      async decide(observation: AgentObservation): Promise<AgentDecision> {
        seen.push(observation);
        const next = answers[Math.min(i, answers.length - 1)]!;
        i += 1;
        return { selector: '', value: '', url: '', reasoning: 'scripted', ...next };
      },
    },
  };
}

describe('the agent loop refuses a wasted turn (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        path === '/en/done'
          ? '<h1>Done</h1>'
          : path === '/en/rows'
            ? '<h1>Plans</h1><table><tr><td>TH_MED_001</td><td><button onclick="document.title=\'deleted TH_MED_001\'">Delete</button></td></tr>' +
              '<tr><td>PL_03_18</td><td><button onclick="document.title=\'deleted PL_03_18\'">Delete</button></td></tr></table>'
            : '<h1>Start</h1><a id="go" href="/en/done">Continue</a><button>Only button</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('does not accept a finish that contradicts the goal\'s destination', async () => {
    // The model insists it is done while still on /en/start. Before, this was
    // success=true and the runner's evidence check — which only runs on
    // failures — never saw it. The destination is one the tree does NOT link
    // to and the goal names a route, so neither zero-call rung can settle it
    // and the model is genuinely asked.
    const { model, seen } = scripted([{ action: 'finish', reasoning: 'done' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, `continue via the button and end on ${origin}/en/elsewhere`);
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /claimed finish, but the goal ends on/);
    assert.equal(seen.length, 2, 'one re-ask, with the reason');
    assert.match(seen[1]?.feedback ?? '', /the goal ends on/);
  });

  it('stops as stalled when an ok action is repeated on an unchanged page', async () => {
    // PB_03_01's shape: the same action, again and again, nothing moving.
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Only button"]' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 8 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'press the only button until something happens');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /stalled/);
    // Turn 1 acts; turn 2 is refused once (feedback), refused again → stall.
    // Three asks in total, not eight turns of the same click.
    assert.equal(seen.length, 3);
    assert.match(seen[2]?.feedback ?? '', /already did/);
    assert.equal(result.turns, 2, 'the budget is not spent on repeats');
  });

  it('runs unbounded by default and stops itself after consecutive turns of no progress', async () => {
    // No maxSteps: the fixed turn ceiling is gone (2026-08-24), and the judge
    // that ends a going-nowhere loop is evidence — AGENT_NO_PROGRESS_TURNS
    // consecutive turns in which nothing succeeded. A FRESH failing action
    // every turn slips past the repeat guard (it only catches the same action
    // twice on an unchanged page); this is the stop that catches it.
    const { model, seen } = scripted(
      Array.from({ length: AGENT_NO_PROGRESS_TURNS + 2 }, (_, i) => ({
        action: 'goto' as const,
        url: `https://site-${i}.example/`,
      })),
    );
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'reach the reporting screen');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, new RegExp(`stalled: nothing advanced in ${AGENT_NO_PROGRESS_TURNS} consecutive turns`));
    assert.equal(result.turns, AGENT_NO_PROGRESS_TURNS, 'stopped by the judge, not a ceiling');
    assert.equal(seen.length, AGENT_NO_PROGRESS_TURNS, 'one ask per turn — a goto is refused in the act, never re-asked');
    assert.equal(result.maxSteps, null, 'no ceiling was set, and the record says so');
  });

  it('lets a repeated scroll or wait through, as a turn that advances nothing — never as a stall', async () => {
    // be100, 2026-08-25: seven runs ended as `stalled: repeated "scroll "` /
    // `"wait "` — the model asked to look again, was told it already had,
    // insisted once, and the run was recorded as a harness error with the
    // goal's control on screen. Looking again cannot change the app, so it is
    // never the stall the repeat guard exists for (the same fill, four
    // times); it is also never progress, so a loop that only looks still
    // ends — on the no-progress judge, after AGENT_NO_PROGRESS_TURNS.
    const { model, seen } = scripted([{ action: 'scroll' }]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'find the export button');
    });
    assert.equal(result.success, false);
    assert.doesNotMatch(result.summary, /repeated/, 'a scroll is not a stall');
    assert.match(result.summary, /nothing advanced/);
    assert.equal(result.turns, AGENT_NO_PROGRESS_TURNS);
    assert.ok(
      seen.some((o) => /will not reveal more/.test(o.feedback ?? '')),
      'the model was told once, per turn, that looking again changes nothing',
    );
    assert.ok(
      result.actions.filter((a) => a.action === 'scroll' && a.ok).length >= AGENT_NO_PROGRESS_TURNS,
      'the insisted-on scrolls were performed, not refused',
    );
  });

  it('fails a scroll to a name the tree does not show fast, like a click', async () => {
    // Before: scrollIntoViewIfNeeded waited the full action timeout on a row
    // a virtualised table had not rendered — three turns of 5 s each, and
    // the error the next turn read said nothing about WHY.
    const { model, seen } = scripted([
      { action: 'scroll', selector: 'role=cell[name="PL_99_99 nowhere" i]' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 2 });
    const started = Date.now();
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'bring the PL_99_99 row into view');
    });
    assert.equal(result.success, false);
    assert.match(seen[1]?.feedback ?? '', /not in the accessibility tree/, 'refused once with the reason');
    const scroll = result.actions[0];
    assert.equal(scroll?.ok, false);
    assert.match(scroll?.error ?? '', /no element matches/);
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
  });

  it('re-asks once when the selector names nothing in the tree, then fails fast', async () => {
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Create Plan"]' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 2 });
    const started = Date.now();
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'click Create Plan');
    });
    assert.equal(result.success, false);
    assert.match(seen[1]?.feedback ?? '', /not in the accessibility tree/);
    const click = result.actions[0];
    assert.equal(click?.ok, false);
    assert.match(click?.error ?? '', /no element matches/);
    // Two turns of a missing selector, each failing fast — well under the
    // 8 s per action the old path waited.
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
  });

  it('never presses an unscoped Delete, however the model insists, and still lets a scoped one through', async () => {
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Delete" i] >> nth=0' },
      { action: 'click', selector: 'role=button[name="Delete" i] >> nth=0' },
      // The scoped shape a real run used successfully: find the id's cell,
      // step up to its row, press that row's own Delete.
      { action: 'click', selector: 'text=PL_03_18 >> xpath=.. >> role=button[name="Delete" i]' },
      { action: 'finish', reasoning: 'deleted' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'deleted PL_03_18', 'only the row the goal named was deleted');
    assert.equal(result.success, true, result.summary);
    const refused = result.actions[0];
    assert.equal(refused?.ok, false);
    assert.match(refused?.error ?? '', /^destructive:/);
    assert.match(seen[1]?.feedback ?? '', /without naming which row/, 'told once, with the scoped shape');
    // Refused twice in turn 1 (recorded once, never acted on); turn 2 is the scoped click; turn 3 finishes.
    assert.equal(result.turns, 3);
  });

  it('refuses a goto off every known origin, and allows the goal\'s own', async () => {
    const { model } = scripted([
      { action: 'goto', url: 'https://example.com/' },
      { action: 'goto', url: `${origin}/en/done` },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto('about:blank');
      return agent.run(page, `open ${origin}/en/done`);
    });
    assert.equal(result.actions[0]?.ok, false, 'the public internet is refused');
    assert.match(result.actions[0]?.error ?? '', /off-origin/);
    assert.equal(result.success, true, 'the origin the goal names is allowed, and arriving finishes');
  });
});

describe('a read-only agent run', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    // A summary card, the be100 shape: label and value in separate elements,
    // plus a button the agent must not be able to press.
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>Plans</h1><div id="card"><span>TOTAL PLANS</span><span>75</span></div>' +
          '<button onclick="document.title=\'the agent acted\'">Delete everything</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('refuses every action that could change the page, and still lets it answer', async () => {
    // Asking an assertion's question is only safe if the agent structurally
    // cannot make the claim true. A prompt saying "do not click" is a
    // promise; this is a guarantee.
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Delete everything" i]' },
      { action: 'scroll' },
      { action: 'finish', selector: '#card', reasoning: 'the card holds the label and the count' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 5 });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/cards`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'which element holds the text "75" for TOTAL PLANS?', {
        readOnly: true,
      });
      return { result, title: await page.title() };
    });

    assert.notEqual(title, 'the agent acted', 'the button was never pressed');
    assert.equal(result.actions.some((a) => a.action === 'click' && a.ok), false);
    assert.match(seen[1]?.feedback ?? '', /is not available to this run/, 'told once, with the reason');
    assert.match(seen[1]?.feedback ?? '', /it may only wait, scroll/, 'and told what it may do');
    // And the answer still comes back: the finish carries the selector.
    const answer = [...result.actions].reverse().find((a) => a.action === 'finish');
    assert.equal(answer?.selector, '#card');
  });
});

describe('a consent gate met mid-run (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    // The measured shape: the plans page redirects to /en/consent until the
    // session has accepted; accepting lands on the app's HOME, not on the
    // page that was asked for.
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const consented = /(^|;\s*)consent=1/.test(req.headers.cookie ?? '');
      if (path === '/en/plans' && !consented) {
        res.writeHead(302, { location: '/en/consent' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (path === '/en/consent') {
        res.end(
          '<h1>Consent</h1><p>Personal data notice</p>' +
            '<button onclick="document.cookie=\'consent=1; path=/\'; location.href=\'/en/home\'">Accept and continue</button>',
        );
      } else if (path === '/en/plans') {
        res.end(
          '<h1>Plans</h1><button id="do" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Thing done</p>\')">Do the thing</button>',
        );
      } else {
        res.end(path === '/en/home' ? '<h1>Home</h1>' : '<h1>Start</h1>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('is cleared without a model turn, and the agent is returned to the page its goto asked for', async () => {
    // be100 PL_03_16, 2026-08-25: a goto to the plans page landed on
    // /en/consent; the model scrolled, waited, waited, and the run ended as a
    // stall with the accept control on screen. The preflight's gate rung
    // only ran before the first turn.
    const { model, seen } = scripted([
      { action: 'goto', url: `${origin}/en/plans` },
      { action: 'click', selector: 'role=button[name="Do the thing" i]' },
      { action: 'finish', reasoning: 'the thing is done' },
    ]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.context().clearCookies();
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'open the plans page and press Do the thing');
    });
    assert.equal(result.success, true, result.summary);
    const gate = result.actions.find((a) => /consent gate/.test(a.reasoning));
    assert.ok(gate?.ok, 'the gate was accepted by the loop, not the model');
    assert.match(gate?.reasoning ?? '', /on turn 2/);
    assert.ok(
      seen.every((o) => !/consent/i.test(o.url)),
      'the model was never asked to decide from the consent page',
    );
    const click = result.actions.find((a) => a.action === 'click' && /Do the thing/.test(a.selector ?? ''));
    assert.ok(click?.ok, 'the click landed on the plans page the goto asked for');
    assert.match(click?.url ?? '', /\/en\/plans$/);
  });
});

describe('parseWherePairs', () => {
  it('reads equality pairs into a record', () => {
    assert.deepEqual(parseWherePairs('benefit_type=REIMBURSEMENT_HR, status = ACTIVE'), {
      benefit_type: 'REIMBURSEMENT_HR',
      status: 'ACTIVE',
    });
  });
  it('an empty value means the whole table', () => {
    assert.deepEqual(parseWherePairs(''), {});
  });
  it('refuses a pair it cannot read, naming it', () => {
    assert.throws(() => parseWherePairs('not-a-pair'), /could not read "not-a-pair"/);
  });
});

describe('the dbCount action (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Plans</h1><p>Reimbursement by HR: 3</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('is in the vocabulary, and the observed count is the evidence in the record', async () => {
    assert.ok((AGENT_ACTIONS as readonly string[]).includes('dbCount'));
    const asked: Array<{ table: string; where: Record<string, string> }> = [];
    const { model, seen } = scripted([
      {
        action: 'dbCount',
        selector: 'benefit_management.benefit_plan',
        value: 'benefit_type=REIMBURSEMENT_HR',
      },
      { action: 'finish', reasoning: 'the database says 3 and the box says 3' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'verify the Reimbursement by HR count matches the database', {
        dbProbe: async (table, where) => {
          asked.push({ table, where });
          return 3;
        },
      });
    });
    // The probe was asked the grounded question the decision encoded…
    assert.deepEqual(asked, [
      { table: 'benefit_management.benefit_plan', where: { benefit_type: 'REIMBURSEMENT_HR' } },
    ]);
    // …and what the database actually said is on the record and in the
    // history the model reasons from — evidence, never just the claim.
    assert.equal(result.actions[0]?.ok, true);
    assert.match(seen[1]?.history.join('\n') ?? '', /dbCount benefit_management\.benefit_plan — ok \(observed 3 row\(s\)\)/);
  });

  it('fails with advice, not a connection error, when no database is configured', async () => {
    const { model } = scripted([
      { action: 'dbCount', selector: 'benefit_management.benefit_plan', value: '' },
      { action: 'fail', reasoning: 'cannot verify without a database' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'verify the count matches the database');
    });
    assert.equal(result.actions[0]?.ok, false);
    assert.match(result.actions[0]?.error ?? '', /no database is configured .* verify through the page/);
  });
});
