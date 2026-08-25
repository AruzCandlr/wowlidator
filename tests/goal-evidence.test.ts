/**
 * Goal evidence — what the page shows about a workflow goal, as against what
 * the agent says about it.
 *
 * The pure rules run always: they are string and URL comparisons with no model
 * and no browser in them, the same tier as `context-engine.test.ts`. The
 * early-exit test is browser-tier, because "the agent stopped spending turns
 * once the page arrived" is a fact about a loop driving a real page, and the
 * bug it guards — an agent that kept deciding after its goal was met — was
 * invisible to every pure assertion about the predicate itself.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  agentModelUnavailable,
  atGoalDestination,
  destinationReached,
  goalDestination,
  goalEvidence,
  goalMentionsSignIn,
  looksLikeSignIn,
  verificationOnlyGoal,
} from '../src/orchestrator/goal-evidence.js';
import { WorkflowAgent, type AgentDecision } from '../src/orchestrator/workflow-agent.js';
import { withPage } from '../src/engine/runner.js';

describe('goalDestination', () => {
  it('takes the path out of a URL written into the goal', () => {
    assert.equal(
      goalDestination(
        'Enter password hrbp2026, click Sign in, accept PDPA consent if shown, and navigate to ' +
          'probation queue at http://localhost:3000/en/workflows/probation',
      ),
      '/en/workflows/probation',
    );
  });

  it('takes the LAST destination, because a goal ends where it arrives', () => {
    assert.equal(
      goalDestination('from http://x.test/en/login go to http://x.test/en/home'),
      '/en/home',
    );
  });

  it('reads a bare path when no absolute URL is given', () => {
    assert.equal(
      goalDestination('verify the Review link points to /workflows/probation/PB-001'),
      '/workflows/probation/PB-001',
    );
  });

  it('trims the sentence punctuation a URL picked up from its prose', () => {
    assert.equal(goalDestination('then land on http://x.test/en/home.'), '/en/home');
  });

  it('is null for a goal that names no path at all', () => {
    assert.equal(goalDestination('open menu Team Management -> Probation Reviews'), null);
  });

  it('refuses a bare root, which would match every URL there is', () => {
    assert.equal(goalDestination('go to http://x.test/'), null);
  });
});

describe('atGoalDestination', () => {
  it('contains rather than equals, so a locale prefix does not defeat it', () => {
    assert.equal(atGoalDestination('http://x.test/en/workflows/probation', '/workflows/probation'), true);
  });

  it('is false for a different page', () => {
    assert.equal(atGoalDestination('http://x.test/en/consent', '/workflows/probation'), false);
  });
});

describe('goalEvidence', () => {
  const GOAL_URL =
    'Enter password hrbp2026, click Sign in, and navigate to http://localhost:3000/en/workflows/probation';
  const GOAL_LABEL = 'Sign in with password hrbp2026, then open Team Management -> Probation Reviews';

  it('settles a goal whose destination the page reached', () => {
    const evidence = goalEvidence(
      GOAL_URL,
      'http://localhost:3000/en/login',
      'http://localhost:3000/en/workflows/probation',
    );
    assert.equal(evidence?.rule, 'destination');
  });

  it('settles a sign-in goal that left the sign-in page', () => {
    const evidence = goalEvidence(
      GOAL_LABEL,
      'http://localhost:3000/en/login',
      'http://localhost:3000/en/workflows/probation',
    );
    assert.equal(evidence?.rule, 'left-sign-in');
  });

  // The false-pass hazard, and the reason the destination rule is exclusive:
  // this agent DID leave the sign-in page, and it stranded on a consent screen
  // instead of the destination its goal named. Live, 2026-08-19.
  it('never falls through to the weaker rule when the goal named a destination', () => {
    const stranded = goalEvidence(
      'Enter password admin2026, click Sign in, and navigate to employee ' +
        'http://localhost:3000/en/admin/employees/EMP-0005/probation',
      'http://localhost:3000/en/login',
      'http://localhost:3000/en/consent',
    );
    assert.equal(stranded, null, 'stranding short of the destination is not success');
  });

  // The gate between signing in and the application. Leaving /en/login for
  // /en/consent is the sign-in half done, not done: nothing behind the gate is
  // reachable yet, and a claim judged from here is judged against the gate.
  it('does not count a sign-in that stranded on a consent gate', () => {
    assert.equal(
      goalEvidence(GOAL_LABEL, 'http://localhost:3000/en/login', 'http://localhost:3000/en/consent'),
      null,
    );
  });

  it('requires a transition — standing still settles nothing', () => {
    assert.equal(
      goalEvidence(GOAL_URL, 'http://x.test/en/workflows/probation', 'http://x.test/en/workflows/probation'),
      null,
    );
    assert.equal(
      goalEvidence(GOAL_LABEL, 'http://x.test/en/login', 'http://x.test/en/login'),
      null,
    );
  });

  it('says nothing about a goal that mentions no sign-in and names no path', () => {
    assert.equal(
      goalEvidence('Open and inspect all seven probation cases one by one', 'http://x.test/a', 'http://x.test/b'),
      null,
    );
  });
});

describe('verificationOnlyGoal', () => {
  it('is true for a goal that asks only to look — the assertion\'s job, not the agent\'s', () => {
    // be100 PL_03_01 (2026-08-25): this goal cost five turns, ended "agent
    // stalled", failed the step with a `high` defect — and the next step's
    // expectText "75" passed against the very page the agent stood on.
    assert.equal(verificationOnlyGoal('verify the Total Plans summary card shows count 75'), true);
    assert.equal(verificationOnlyGoal('check that the Records box reads 5'), true);
    assert.equal(
      verificationOnlyGoal('ตรวจสอบจำนวน Reimbursement by HR ที่แสดงบนหน้าจอ'),
      true,
      'the sheet\'s own language counts',
    );
  });

  it('is false the moment the goal asks for any work', () => {
    // Narrow on purpose: a leg that acts and then checks is a real leg, and
    // its failure is a real failure.
    assert.equal(verificationOnlyGoal('open the Status dropdown and verify Active is listed'), false);
    assert.equal(verificationOnlyGoal('click Create Plan, then check the dialog title'), false);
    assert.equal(verificationOnlyGoal('navigate to the plans page and confirm that it loaded'), false);
    // No verify verb at all is not a verification goal either.
    assert.equal(verificationOnlyGoal('reach the application details page'), false);
  });
});

describe('provider failure is not an application failure', () => {
  it('recognises the agent model having failed', () => {
    assert.equal(
      agentModelUnavailable(
        'agent model failed: openrouter:google/gemini-3.6-flash structured-output circuit is open',
      ),
      true,
    );
  });

  it('does not mistake an ordinary give-up for one', () => {
    assert.equal(agentModelUnavailable('agent gave up after 8 turns without reaching the goal'), false);
    assert.equal(agentModelUnavailable('agent reported the goal is unreachable: no such control'), false);
  });
});

describe('sign-in detection', () => {
  it('reads the usual authentication paths', () => {
    for (const url of ['http://x.test/en/login', 'http://x.test/signin', 'http://x.test/auth/sso']) {
      assert.equal(looksLikeSignIn(url), true, url);
    }
    assert.equal(looksLikeSignIn('http://x.test/en/workflows/probation'), false);
  });

  it('spots a goal that asks for authentication', () => {
    assert.equal(goalMentionsSignIn('Enter password hrbp2026 and click Sign in'), true);
    assert.equal(goalMentionsSignIn('Open every probation case in turn'), false);
  });
});

describe('destinationReached', () => {
  it('is the mid-flight rule and never the sign-in one', () => {
    // Left the sign-in page, but the goal named a destination it has not
    // reached: mid-flight this must NOT stop the agent.
    assert.equal(
      destinationReached(
        'sign in then go to http://x.test/en/home',
        'http://x.test/en/login',
        'http://x.test/en/consent',
      ),
      false,
    );
  });
});

// --- the loop itself -------------------------------------------------------

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

describe('the agent stops when the page arrives (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        req.url?.startsWith('/en/workflows/probation')
          ? '<h1>Probation Reviews</h1>'
          // A BUTTON, not a link: a link to the destination would be taken by
          // the agent's pre-flight with no model turn at all, and this test
          // is about the loop stopping on arrival when the model never says
          // finish — so the model has to be the one that clicks.
          : '<h1>Sign in</h1><button id="go" onclick="location.href=\'/en/workflows/probation\'">Continue</button>',
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

  it('spends no turn after reaching the destination the goal names', async () => {
    // A model that never says `finish` — exactly the live failure, where the
    // agent kept re-filling a password field it had already submitted. The
    // loop must stop on the page's evidence, not on the model's say-so.
    let turns = 0;
    const agent = new WorkflowAgent({
      model: {
        id: 'stub:never-finishes',
        async decide(): Promise<AgentDecision> {
          turns += 1;
          return { action: 'click', selector: '#go', value: '', url: '', reasoning: 'keep going' };
        },
      },
      maxSteps: 8,
    });

    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/login`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, `sign in via the Continue button and go to ${origin}/en/workflows/probation`);
    });

    assert.equal(result.success, true, result.summary);
    assert.equal(result.turns, 1, 'arriving is finishing — the remaining budget must go unspent');
    assert.equal(turns, 1);
    assert.match(result.summary, /destination the goal names/);
  });
});
