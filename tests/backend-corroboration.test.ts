/**
 * The rules that decide a verdict when the page and the backend both have
 * something to say — unit tier throughout, because every one of them is a
 * decision, not a browser fact.
 *
 * Every fixture here is HIR-EC-029's real shape (run
 * `ec-ready-failed-20260910-162031`): the claim "the Event Reason dropdown
 * shows exactly 3 values", proved by a page-wide `expectCount role=option`
 * that found 4 because an unrelated postal-code `<select>` contributed its
 * placeholder `<option>`, against the lookup the page really fetched —
 * `GET /humi/api/employee-foundation/foundation?type=picking_lists&size=1000`,
 * observed 200 eight times during that very step.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkCall } from '../src/api/network-observer.js';
import { LlmFactory } from '../src/providers/llm-factory.js';
import {
  compareDbReading,
  dbOutcomeOf,
  planDbLookup,
  LocationSchema,
  LlmCorroborationModel,
  VERDICT_TASK,
  clickRecovery,
  compareToBackend,
  corroboratedVerdict,
  navigationIsTheClaim,
  pickBackendCandidate,
  readJsonPath,
  reloadSafe,
  reloadSkipReason,
  uiReadingOf,
  type CorroborationOutcome,
} from '../src/engine/backend-corroboration.js';

const LOOKUP = 'https://humi-sit-int.central.co.th/humi/api/employee-foundation/foundation?type=picking_lists&size=1000';

function call(over: Partial<NetworkCall> = {}): NetworkCall {
  return {
    id: 'r1',
    method: 'GET',
    url: LOOKUP,
    resourceType: 'xhr',
    status: 200,
    startedAt: 1,
    ...over,
  };
}

describe('a reload may not destroy the state the step is about', () => {
  it('allows the re-check on a settled page', () => {
    assert.equal(reloadSafe(['goto', 'expectVisible']), true);
    assert.equal(reloadSkipReason(['goto', 'expectVisible']), null);
  });

  it("refuses it after the click that opened HIR-EC-029's dropdown", () => {
    // The failing assertion was about an OPEN list. A reload closes it, so the
    // re-check could only ever fail — and would report a different failure
    // than the real one.
    assert.equal(reloadSafe(['click', 'expectCount']), false);
    assert.match(reloadSkipReason(['click', 'expectCount']) ?? '', /would discard the state this step is about/);
  });

  it('refuses it after input, where a reload loses everything typed', () => {
    for (const action of ['fill', 'type', 'selectOption', 'check', 'paste', 'press']) {
      assert.equal(reloadSafe(['goto', action]), false, `${action} changes the page`);
    }
  });
});

describe('only an inconclusive UI reading defers to the backend', () => {
  it('a resolved element that disagreed is the page speaking', () => {
    assert.equal(uiReadingOf('failed', true), 'contradicted');
  });

  it('a selector that never resolved never got to answer', () => {
    assert.equal(uiReadingOf('dead-end', false), 'inconclusive');
    assert.equal(uiReadingOf('failed', false), 'inconclusive');
  });

  it('a pass is a pass', () => {
    assert.equal(uiReadingOf('passed', false), 'passed');
  });
});

describe('which endpoint is re-fetched', () => {
  it("prefers an endpoint the flow's own author named", () => {
    const picked = pickBackendCandidate([{ method: 'GET', url: '/api/authored' }], [call()]);
    assert.equal(picked?.url, '/api/authored');
    assert.match(picked?.because ?? '', /the author's own/);
  });

  it("otherwise takes the page's own observed lookup", () => {
    const picked = pickBackendCandidate([], [call()]);
    assert.equal(picked?.url, LOOKUP);
    assert.match(picked?.because ?? '', /the page fetched this while the step ran/);
  });

  it('never replays a mutation, and never trusts a call that failed', () => {
    assert.equal(pickBackendCandidate([], [call({ method: 'POST' })]), null);
    assert.equal(pickBackendCandidate([], [call({ status: 500 })]), null);
    assert.equal(pickBackendCandidate([], [call({ status: undefined })]), null);
    // A document navigation is not the claim's data source.
    assert.equal(pickBackendCandidate([], [call({ resourceType: 'document' })]), null);
  });

  it('says nothing when there is no backend to ask — validation ends at the reload', () => {
    assert.equal(pickBackendCandidate([], []), null);
  });
});

describe('the mapping is verified before it is believed', () => {
  const body = JSON.stringify({
    data: { picking_lists: { event_reason: ['H_NEWHIRE', 'H_RPLMENT', 'HIREDM'], salutation: ['Mr', 'Ms'] } },
  });

  it('reads a dotted path, arrays included', () => {
    assert.deepEqual(readJsonPath(JSON.parse(body), 'data.picking_lists.event_reason'), [
      'H_NEWHIRE',
      'H_RPLMENT',
      'HIREDM',
    ]);
    assert.equal(readJsonPath(JSON.parse(body), 'data.picking_lists.event_reason.1'), 'H_RPLMENT');
  });

  it("confirms HIR-EC-029's real claim: the backend holds exactly 3", () => {
    const out = compareToBackend(body, { path: 'data.picking_lists.event_reason', read: 'count', reasoning: '' }, '3', LOOKUP);
    assert.equal(out.kind, 'confirmed');
    assert.equal(out.kind === 'confirmed' ? out.found : '', '3');
  });

  it('contradicts when the backend genuinely holds something else', () => {
    const out = compareToBackend(body, { path: 'data.picking_lists.salutation', read: 'count', reasoning: '' }, '3', LOOKUP);
    assert.equal(out.kind, 'contradicted');
    assert.equal(out.kind === 'contradicted' ? out.found : '', '2');
  });

  it('a path the response does not hold is UNAVAILABLE, never a verdict', () => {
    // The whole safety of the model half: a wrong guess must not decide
    // anything. Same rule `#verify` applies to a healed selector.
    const out = compareToBackend(body, { path: 'data.invented.field', read: 'count', reasoning: '' }, '3', LOOKUP);
    assert.equal(out.kind, 'unavailable');
    assert.match(out.kind === 'unavailable' ? out.reason : '', /holds no "data\.invented\.field"/);
  });

  it('a non-JSON response settles nothing', () => {
    const out = compareToBackend('<html>nope</html>', { path: 'a', read: 'value', reasoning: '' }, '3', LOOKUP);
    assert.equal(out.kind, 'unavailable');
  });
});

describe('the verdict table', () => {
  const confirmed: CorroborationOutcome = { kind: 'confirmed', query: LOOKUP, path: 'p', found: '3', expected: '3' };
  const contradicted: CorroborationOutcome = { kind: 'contradicted', query: LOOKUP, path: 'p', found: '9', expected: '3' };
  const unavailable: CorroborationOutcome = { kind: 'unavailable', reason: 'no endpoint' };

  it('a page that proved its claim passes, whatever the backend says', () => {
    assert.equal(corroboratedVerdict('passed', contradicted).status, 'passed');
  });

  it('a page that resolved and disagreed still FAILS — the backend may not overrule it', () => {
    // The rule that keeps a broken page from going green on healthy data.
    const verdict = corroboratedVerdict('contradicted', confirmed);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.defect, 'frontend');
    assert.match(verdict.why, /rendering fault/);
  });

  it('inconclusive + backend correct = a FRONTEND defect carrying the backend proof', () => {
    const verdict = corroboratedVerdict('inconclusive', confirmed);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.defect, 'frontend');
    assert.match(verdict.why, /the page never rendered it/);
  });

  it('inconclusive + backend wrong = the defect is the backend’s', () => {
    const verdict = corroboratedVerdict('inconclusive', contradicted);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.defect, 'backend');
  });

  it('inconclusive + no backend = fails as the UI failed', () => {
    for (const backend of [unavailable, null]) {
      const verdict = corroboratedVerdict('inconclusive', backend);
      assert.equal(verdict.status, 'failed');
      assert.equal(verdict.defect, null);
      assert.match(verdict.why, /no backend check was available/);
    }
  });
});

describe('a click that did not take', () => {
  it('is retried after a reload first, when the page state allows it', () => {
    assert.deepEqual(
      clickRecovery({ reloadAlreadyTried: false, reloadSafe: true, routeUrl: '/admin/hire', caseText: 'open the page' }),
      { kind: 'retry-after-reload' },
    );
  });

  it("takes the control's own route once the reload has been spent", () => {
    const out = clickRecovery({
      reloadAlreadyTried: true,
      reloadSafe: true,
      routeUrl: '/admin/hire',
      caseText: 'open the Add New Employee page',
    });
    assert.deepEqual(out, { kind: 'route', url: '/admin/hire' });
  });

  it('refuses to route when the case reaches the page through the menu', () => {
    // The sheets' own rule: ไม่เปิด URL ข้าม assertion. A case about the menu
    // cannot be passed by a URL that never touched it.
    const out = clickRecovery({
      reloadAlreadyTried: true,
      reloadSafe: true,
      routeUrl: '/admin/hire',
      caseText: '2. เปิดหน้า Add New Employee\n- เมนูซ้าย EC > Hire & Onboard',
    });
    assert.equal(out.kind, 'fail');
    assert.match(out.kind === 'fail' ? out.why : '', /would skip the very thing this case tests/);
    assert.equal(navigationIsTheClaim('เมนูซ้าย EC > Hire'), true);
    assert.equal(navigationIsTheClaim('open the URL directly'), false);
  });

  it('invents no path for a button whose handler calls a router', () => {
    const out = clickRecovery({
      reloadAlreadyTried: true,
      reloadSafe: true,
      routeUrl: undefined,
      caseText: 'press Save',
    });
    assert.equal(out.kind, 'fail');
    assert.match(out.kind === 'fail' ? out.why : '', /carries no route of its own/);
  });
});

/**
 * The verdict model rides the AGENT's configuration — no new role, no second
 * setting to keep in step (asked for 2026-09-11) — while keeping a circuit of
 * its own, because a payload it cannot map must never refuse the workflow
 * agent's next leg on the same model.
 */
describe('verdict-agent is the agent role, with its own circuit', () => {
  it('resolves its label from the agent role, so one setting moves both', () => {
    const factory = new LlmFactory({
      roles: {
        agent: { provider: 'groq', model: 'some-agent-model', apiKey: 'k' },
      } as never,
    } as never);
    const model = new LlmCorroborationModel({ factory });
    assert.equal(model.id, factory.labelFor('agent'), 'the verdict model must never resolve a role of its own');
  });

  it('names its ask "verdict-agent", which is what keys the breaker apart', () => {
    // `task@model` is the breaker key (src/providers/CLAUDE.md). Sharing the
    // role's CONFIG must not mean sharing the role's circuit.
    assert.equal(VERDICT_TASK, 'verdict-agent');
  });

  it('asks the model for a path, never for a verdict', () => {
    // The schema is the guarantee: there is no field a model could answer
    // "pass" or "fail" in. The comparison stays in `compareToBackend`.
    const fields = Object.keys(
      (LocationSchema as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();
    assert.deepEqual(fields, ['path', 'read', 'reasoning']);
  });
});

describe('a count that resolved is the page answering (HIR-EC-029, 2026-09-11)', () => {
  it('treats a state contradiction as the page speaking, not as inconclusive', () => {
    // `expected 3 matches, found 4` — the selector resolved and counted. The
    // backend may not overrule that; it may only explain it.
    assert.equal(uiReadingOf('failed', true), 'contradicted');
    const verdict = corroboratedVerdict('contradicted', {
      kind: 'confirmed', query: LOOKUP, path: 'data.picking_lists.event_reason', found: '3', expected: '3',
    });
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.defect, 'frontend');
    assert.match(verdict.why, /rendering fault/);
  });
});

/**
 * The database as a corroboration source, and the rails that make a
 * model-chosen query safe (2026-09-11).
 */
describe('a database corroboration is planned, never written by the model', () => {
  const schema = {
    tables: [{ name: 'picking_list', columns: ['id', 'type', 'code', 'label', 'password_hash'] }],
  };
  const q = (name: string) => `"${name}"`;

  it('builds a parameterised SELECT — the model names parts, never SQL', () => {
    const plan = planDbLookup(
      { table: 'picking_list', column: 'code', where: { type: 'event_reason' }, read: 'count' },
      schema,
      q,
    );
    assert.ok(!('refused' in plan));
    if ('refused' in plan) return;
    assert.equal(plan.sql, 'SELECT count(*) AS v FROM "picking_list" WHERE "type" = $1');
    assert.deepEqual(plan.params, ['event_reason']);
    // The value never reaches the statement text.
    assert.doesNotMatch(plan.sql, /event_reason/);
  });

  it('refuses every identifier the introspected schema does not declare', () => {
    for (const bad of [
      { table: 'invented', column: 'code', where: {}, read: 'count' as const },
      { table: 'picking_list', column: 'invented', where: {}, read: 'count' as const },
      { table: 'picking_list', column: 'code', where: { invented: 'x' }, read: 'count' as const },
    ]) {
      const plan = planDbLookup(bad, schema, q);
      assert.ok('refused' in plan, `${JSON.stringify(bad)} must be refused, not queried`);
    }
  });

  it('only ever builds a SELECT', () => {
    const plan = planDbLookup({ table: 'picking_list', column: 'code', where: {}, read: 'value' }, schema, q);
    if ('refused' in plan) throw new Error('should have planned');
    assert.match(plan.sql, /^SELECT /);
    assert.doesNotMatch(plan.sql, /(?:INSERT|UPDATE|DELETE|DROP|ALTER)/i);
  });

  it("confirms HIR-EC-029's claim from the data, and says so as one verdict shape", () => {
    const plan = { sql: 'SELECT count(*) AS v FROM "picking_list" WHERE "type" = $1', params: ['event_reason'], table: 'picking_list', column: 'code' };
    const evidence = compareDbReading(3, '3', plan, ['event_reason']);
    assert.equal(evidence.outcome, 'confirmed');
    const outcome = dbOutcomeOf(evidence);
    assert.equal(outcome.kind, 'confirmed');
    // The page resolved and counted 4 — the page still loses, and the defect
    // is the frontend's, carrying the query as its proof.
    const verdict = corroboratedVerdict('contradicted', outcome);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.defect, 'frontend');
  });

  it('a query that returns no row settles nothing', () => {
    const plan = { sql: 'SELECT …', params: [], table: 't', column: 'c' };
    const evidence = compareDbReading(null, '3', plan, []);
    assert.equal(evidence.outcome, 'unavailable');
    assert.equal(dbOutcomeOf(evidence).kind, 'unavailable');
  });

  it('keeps the query on the evidence whatever the outcome', () => {
    const plan = { sql: 'SELECT count(*) AS v FROM "picking_list"', params: [], table: 'picking_list', column: 'code' };
    for (const found of [3, 9, null]) {
      const evidence = compareDbReading(found, '3', plan, []);
      assert.equal(evidence.sql, plan.sql, 'the proof page must always be able to say what was asked');
    }
  });
});

/**
 * Both sources, never one instead of the other (2026-09-11).
 *
 * The endpoint says what the page was SERVED; the database says what the
 * system of record HOLDS. They answer different questions — a correct API over
 * stale data agrees with the page and disagrees with the table — so a run asks
 * both, keeps both on the step, and records a disagreement rather than
 * resolving it by precedence.
 */
describe('the endpoint and the database are asked separately', () => {
  it('agreeing sources give one answer', () => {
    const http: CorroborationOutcome = { kind: 'confirmed', query: LOOKUP, path: 'a.b', found: '3', expected: '3' };
    const db: CorroborationOutcome = { kind: 'confirmed', query: 'SELECT count(*) …', path: 'picking_list', found: '3', expected: '3' };
    assert.equal(corroboratedVerdict('inconclusive', http).defect, 'frontend');
    assert.equal(corroboratedVerdict('inconclusive', db).defect, 'frontend');
  });

  it('a disagreement is a real finding, not noise to be averaged away', () => {
    // The API served 3 and the table holds 9: the endpoint is stale or
    // filtered, and that is worth a person's eyes. Each reading keeps its own
    // verdict shape so the step can carry both.
    const http: CorroborationOutcome = { kind: 'confirmed', query: LOOKUP, path: 'a.b', found: '3', expected: '3' };
    const db: CorroborationOutcome = { kind: 'contradicted', query: 'SELECT count(*) …', path: 'picking_list', found: '9', expected: '3' };
    assert.notEqual(http.kind, db.kind);
    // The database is the system of record, so it is the reading the verdict
    // uses — and it names the backend, not the page.
    assert.equal(corroboratedVerdict('inconclusive', db).defect, 'backend');
  });

  it('a database that cannot answer leaves the endpoint reading standing', () => {
    const http: CorroborationOutcome = { kind: 'confirmed', query: LOOKUP, path: 'a.b', found: '3', expected: '3' };
    const db: CorroborationOutcome = { kind: 'unavailable', reason: 'no table holds the subject' };
    assert.equal(dbOutcomeOf({ sql: 'x', params: [], table: 't', column: 'c', found: null, expected: '3', outcome: 'unavailable' }).kind, db.kind);
    assert.equal(corroboratedVerdict('inconclusive', http).defect, 'frontend');
  });
});
