/**
 * A weak claim is looked up before it is merely noted (2026-09-09).
 *
 * Every case here is taken from the live be-cycle1-sit sheet, whose Steps
 * column opens every row with the same preamble — "QA default locale = en;
 * เริ่มที่ https://…/humi/en/login และใช้ /humi/en/ สำหรับทุก route" — followed by
 * the case's real route as a bare path. That shape is what made 12 of 15 rows
 * carry "the sheet's Destination is not followed" on a run whose flows were
 * navigating perfectly well.
 *
 * Unit tier throughout: pure functions, no model, no browser, no database.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  concretiseRoute,
  declaredRouteInCaseText,
  flowReaches,
  flowTravels,
  isEntryPath,
  urlForRoute,
  type ConcreteEvidence,
} from '../src/generator/concretise.js';
import type { FlowStep } from '../src/engine/runner.js';

/** The live sheet's preamble, verbatim, plus the route line that follows it. */
const CASE_TEXT = [
  'QA default locale = en; เริ่มที่ https://humi-sit-int.central.co.th/humi/en/login',
  'และใช้ /humi/en/ สำหรับทุก route',
  '0. Route อ้างอิง /humi/en/admin/benefits/plans (locale=en); หากเคสตรวจเมนู',
  '1. กด Menu',
].join('\n');

// The graph declares routes WITHOUT the deployment's `/humi` base path — the
// shape that made every lookup fail on be-high-sonnet until the deployment URL
// was passed through. Kept verbatim so a regression is caught here, not in a run.
const ROUTES = ['/:locale/admin/benefits/plans', '/:locale/login', '/:locale/home'];
const DEPLOY = 'https://humi-sit-int.central.co.th/humi/en/login';

function evidence(over: Partial<ConcreteEvidence> = {}): ConcreteEvidence {
  return {
    routes: ROUTES,
    existingFixtures: [],
    startUrl: DEPLOY,
    ...over,
  };
}

describe('an entry page is never a destination', () => {
  it('recognises the sign-in and sign-out paths a sheet opens with', () => {
    for (const path of ['/humi/en/login', '/en/signin', '/auth/callback', '/app/logout']) {
      assert.equal(isEntryPath(path), true, path);
    }
  });

  it('leaves an ordinary page alone', () => {
    for (const path of ['/humi/en/admin/benefits/plans', '/humi/en/home']) {
      assert.equal(isEntryPath(path), false, path);
    }
  });
});

describe('the page a case is really about', () => {
  it('matches through the deployment base path the route table does not carry', () => {
    // be-high-sonnet, 2026-09-09: without the deployment URL this was false on
    // every row, and the concretiser silently did nothing ten times over.
    assert.equal(declaredRouteInCaseText(CASE_TEXT, ROUTES), null);
    assert.equal(declaredRouteInCaseText(CASE_TEXT, ROUTES, DEPLOY), '/humi/en/admin/benefits/plans');
  });

  it('takes the declared route the case names, not the login URL that comes first', () => {
    assert.equal(declaredRouteInCaseText(CASE_TEXT, ROUTES, DEPLOY), '/humi/en/admin/benefits/plans');
  });

  it('declines when no repository is indexed — silence is not an answer', () => {
    assert.equal(declaredRouteInCaseText(CASE_TEXT, [], DEPLOY), null);
  });

  it('declines when the repository declares none of the paths the case names', () => {
    assert.equal(declaredRouteInCaseText(CASE_TEXT, ['/totally/other'], DEPLOY), null);
  });

  it('never answers with an entry page, even when that is the only declared one', () => {
    assert.equal(declaredRouteInCaseText(CASE_TEXT, ['/:locale/login'], DEPLOY), null);
  });
});

describe('whether the flow already reaches its page', () => {
  const goto = { action: 'goto', url: 'https://x.test/humi/en/admin/benefits/plans' } as FlowStep;
  const click = { action: 'click', selector: 'role=link[name="Benefit Plans"]' } as FlowStep;
  const assertOnly = { action: 'expectVisible', selector: 'role=button[name="Create Plan"]' } as FlowStep;

  it('counts a goto to that path', () => {
    assert.equal(flowReaches([goto], '/humi/en/admin/benefits/plans'), true);
  });

  it('counts a menu case that clicks its way there as travelling', () => {
    // The sheet forbids jumping by URL on a menu case; clicking IS its route.
    assert.equal(flowTravels([click]), true);
    assert.equal(flowReaches([click], '/humi/en/admin/benefits/plans'), false);
  });

  it('a body of assertions travels nowhere', () => {
    assert.equal(flowTravels([assertOnly]), false);
  });
});

describe('concretiseRoute', () => {
  it('calls the complaint honoured when the flow already travels', () => {
    const steps = [{ action: 'click', selector: 'role=link[name="Benefit Plans"]' } as FlowStep];
    const decided = concretiseRoute(CASE_TEXT, steps, evidence());
    assert.deepEqual(decided, { kind: 'honoured', path: '/humi/en/admin/benefits/plans' });
  });

  it('asks for navigation when the flow reaches no page at all', () => {
    const steps = [{ action: 'expectVisible', selector: 'role=button[name="Create Plan"]' } as FlowStep];
    const decided = concretiseRoute(CASE_TEXT, steps, evidence());
    assert.deepEqual(decided, {
      kind: 'navigate',
      path: '/humi/en/admin/benefits/plans',
      url: 'https://humi-sit-int.central.co.th/humi/en/admin/benefits/plans',
    });
  });

  it('declines when the repository knows nothing, leaving the lint note as written', () => {
    const steps = [{ action: 'expectVisible', selector: 'role=button[name="Create Plan"]' } as FlowStep];
    assert.equal(concretiseRoute(CASE_TEXT, steps, evidence({ routes: [] })), null);
  });

  it('resolves the path against the run’s own deployment', () => {
    assert.equal(
      urlForRoute('/humi/en/admin/benefits/plans', 'https://humi-sit-int.central.co.th/humi/en/login'),
      'https://humi-sit-int.central.co.th/humi/en/admin/benefits/plans',
    );
  });
});
