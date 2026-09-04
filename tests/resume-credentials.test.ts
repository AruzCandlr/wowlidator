/**
 * The panel's two credential rules, both about `src/ui/server.ts`: a resume
 * must not run without the account's password, and no route may ever publish
 * the secret environment a job was started with.
 *
 * The ledger records WHICH account the run signed in as; the password rides
 * the job's env and is never written down. After a panel restart the env is
 * gone, and a resume replayed from argv alone ran blind: every journey capture
 * bounced to the sign-in page, six rows were refused as login-only flows and
 * the rest failed at "Sign in" (ec10, 2026-09-02). The route now answers 409
 * `needsCredentials` with the persona, and the panel asks for the password.
 * Real server, temp working directory; each test file is its own process.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'wow-resume-creds-')));
process.chdir(cwd);
mkdirSync(join(cwd, '.wowlidator', 'catalogs'), { recursive: true });
const ledgerPath = resolve(cwd, '.wowlidator', 'catalogs', 'ec.claims.progress.json');
writeFileSync(
  ledgerPath,
  JSON.stringify({
    version: 1,
    title: 'wowlidator catalog — ec.csv',
    planned: ['A_1', 'A_2'],
    startedAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:10:00.000Z',
    generatedAt: '2026-09-02T09:00:00.000Z',
    runKey: 'ec-csv@2026-09-02T09:00:00.000Z',
    launch: { catalog: join(cwd, 'ec.csv'), claims: join(cwd, '.wowlidator', 'catalogs', 'ec.claims.json'), url: 'http://localhost:3005/en/login', agent: true, persona: 'admin@example.test' },
    outcomes: { A_1: { verdict: 'passed', status: 'passed', reason: null, reportPath: null, at: '2026-09-02T09:05:00.000Z' } },
    ended: { at: '2026-09-02T09:10:00.000Z', cause: 'stopped by SIGINT with 1 case(s) still to run', complete: false },
  }),
  'utf8',
);
const twoAccountLedger = resolve(cwd, '.wowlidator', 'catalogs', 'probation.claims.progress.json');
writeFileSync(
  twoAccountLedger,
  JSON.stringify({
    version: 1,
    title: 'wowlidator catalog — probation.csv',
    planned: ['PR_01_01'],
    startedAt: '2026-09-04T09:00:00.000Z',
    updatedAt: '2026-09-04T09:10:00.000Z',
    generatedAt: '2026-09-04T09:00:00.000Z',
    runKey: 'probation@2026-09-04T09:00:00.000Z',
    launch: {
      catalog: join(cwd, 'probation.csv'),
      claims: join(cwd, '.wowlidator', 'catalogs', 'probation.claims.json'),
      url: 'http://localhost:3005/en/login',
      agent: true,
      persona: 'mgr@x.test',
      personas: { MANAGER_ACCOUNT: 'mgr@x.test', HRBP_ACCOUNT: 'hrbp@x.test' },
    },
    outcomes: {},
    ended: { at: '2026-09-04T09:10:00.000Z', cause: 'stopped', complete: false },
  }),
  'utf8',
);
delete process.env['WOWLIDATOR_AS'];
delete process.env['WOWLIDATOR_PERSONAS'];
// Two keys, so selecting the second one gives the panel a real env overlay to
// hand a job — which is how a live credential gets into `Job.secretEnv`
// without spawning a browser or reaching the network.
process.env['GROQ_API_KEY'] = 'gsk_first_ZZZ111,gsk_second_ZZZ222';

const { startUi } = await import('../src/ui/server.js');

let base = '';
let close: () => void = () => undefined;

describe('a resume rebuilt from the ledger needs the password', () => {
  before(async () => {
    const started = await startUi({ port: 0, open: false });
    base = started.url.replace(/\/$/, '');
    close = started.close;
  });
  after(() => close());

  it('lists the run with the account it signed in as', async () => {
    const res = await fetch(`${base}/api/catalog-runs`);
    const { runs } = (await res.json()) as { runs: { ledgerPath: string; persona: string | null; resumable: boolean }[] };
    const run = runs.find((r) => r.ledgerPath === ledgerPath);
    assert.ok(run, 'the ledger is listed');
    assert.equal(run.persona, 'admin@example.test');
    assert.equal(run.resumable, true);
  });

  it('refuses to continue without the password, naming the account, instead of running blind', async () => {
    const res = await fetch(`${base}/api/catalog-runs/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledgerPath, mode: 'continue' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; needsCredentials?: boolean; persona?: string };
    assert.equal(body.needsCredentials, true);
    assert.equal(body.persona, 'admin@example.test');
    assert.match(body.error, /admin@example\.test/);
    // The password itself is never in the answer — there is none to leak, and
    // the shape must stay that way.
    assert.ok(!JSON.stringify(body).includes('WOWLIDATOR_AS'));
  });
});

/**
 * The other half of the rule `summariseJob` keeps.
 *
 * The list route sheds `secretEnv`; the detail route answered with the raw
 * `Job` and published it. Both surfaces read that route constantly — the
 * launcher polls it every 700 ms while a catalog's claims are read, and a
 * finished run's collapsed console fetches it on expand — so the credential a
 * run was started with was in the browser. It matters more the moment a
 * catalog names more than one account, because then it is every persona's
 * password on the same overlay.
 *
 * `cache-list` is the subject because it opens no browser and touches no
 * network: the leak is about what the route publishes, not what the job does.
 */
describe('a job never publishes the environment it was started with', () => {
  before(async () => {
    const started = await startUi({ port: 0, open: false });
    base = started.url.replace(/\/$/, '');
    close = started.close;
  });
  after(() => close());

  it('strips secretEnv from the full job, while keeping the console', async () => {
    // Pick the second key: that is what makes the panel hand the job an
    // env overlay carrying real key material.
    const selected = await fetch(`${base}/api/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'groq', index: 1 }),
    });
    const selectedBody = await selected.text();
    assert.equal(selected.status, 200, selectedBody);

    const started = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cache-list', values: {} }),
    });
    const startedBody = await started.text();
    assert.equal(started.status, 201, startedBody);
    const { job } = JSON.parse(startedBody) as { job: { id: string } };

    const detail = await fetch(`${base}/api/jobs/${job.id}`);
    assert.equal(detail.status, 200);
    const body = await detail.text();

    assert.ok(!body.includes('gsk_second_ZZZ222'), 'no key value in the job detail');
    assert.ok(!body.includes('gsk_first_ZZZ111'), 'not even the one it started on');
    assert.ok(!body.includes('secretEnv'), 'not even the field name');
    // …and the reason the detail route exists is still served: unlike the
    // list, it carries the output buffer and the per-case rows whole.
    const parsed = JSON.parse(body) as { job: Record<string, unknown> };
    assert.ok(Array.isArray(parsed.job['lines']), 'the console is still there');
    assert.ok(Array.isArray(parsed.job['cases']), 'and the per-case rows');
    assert.equal(parsed.job['id'], job.id);
  });
});

/**
 * A catalog whose rows change hands names more than one account. The ledger
 * has recorded every one of them since it learned `launch.personas`, and the
 * resume gate read only the single `--as` email — so a restarted panel started
 * the run with the first account's password and none of the others, and every
 * case needing the second person died at its `signIn`.
 */
describe('a resume of a run that changes hands asks for every account', () => {
  before(async () => {
    const started = await startUi({ port: 0, open: false });
    base = started.url.replace(/\/$/, '');
    close = started.close;
  });
  after(() => close());

  const resume = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/catalog-runs/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledgerPath: twoAccountLedger, mode: 'continue', ...body }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('refuses with the first account, then with the other, and never runs half-credentialled', async () => {
    // The single-persona gate still fires first, unchanged.
    const cold = await resume({});
    assert.equal(cold.status, 409);
    assert.equal(cold.body['needsCredentials'], true);
    assert.equal(cold.body['persona'], 'mgr@x.test');

    // With that password given, the run is STILL refused — because the second
    // account has none. Before this, it started here and failed every case
    // that needed the approver.
    const half = await resume({ as: 'mgr@x.test:pw1' });
    assert.equal(half.status, 409);
    assert.equal(half.body['needsCredentials'], true);
    assert.deepEqual(half.body['personas'], [
      { label: 'MANAGER_ACCOUNT', email: 'mgr@x.test' },
      { label: 'HRBP_ACCOUNT', email: 'hrbp@x.test' },
    ]);
    assert.match(String(half.body['error']), /MANAGER_ACCOUNT, HRBP_ACCOUNT/);

    // Supplying one of the two is not enough either: the other is named.
    const partial = await resume({ as: 'mgr@x.test:pw1', personaPasswords: { MANAGER_ACCOUNT: 'pw1' } });
    assert.equal(partial.status, 409);
    assert.deepEqual(partial.body['personas'], [{ label: 'HRBP_ACCOUNT', email: 'hrbp@x.test' }]);

    // No answer along the way carries a password back to the browser.
    for (const answer of [cold, half, partial]) {
      assert.doesNotMatch(JSON.stringify(answer.body), /pw1|WOWLIDATOR_PERSONAS|password"\s*:/);
    }
  });
});

/**
 * The panel remembers WHICH address each account signed in as, and never the
 * password (`src/ui/persona-accounts.ts`). Retyping three addresses before
 * every run is friction; keeping the passwords beside them would be a
 * credential on disk that can sign in on its own, next to a server that binds
 * to a port.
 *
 * Written by the route rather than by the claims phase, so it covers every
 * command that offers `personas` and does not wait for a run to write a
 * ledger — and on the 201 path only: a submission refused with 400 started
 * nothing and must teach the store nothing.
 *
 * `run` with a flow that does not exist is the subject: it offers `personas`,
 * and the CLI reads the flow file before it goes anywhere near a browser, so
 * the job exits immediately and nothing is launched.
 */
describe('the panel remembers an account, never its password', () => {
  const storeFile = join(cwd, '.wowlidator', 'persona-accounts.json');
  // A browser command is serialised, so each job here is waited out before
  // the next starts — it exits on its own the moment the CLI cannot find the
  // flow, which is also why nothing is launched.
  const settle = async (id: string): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      const res = await fetch(`${base}/api/jobs/${id}`);
      const { job } = (await res.json()) as { job: { status: string } };
      if (job.status !== 'running') return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('the job never finished');
  };
  const start = async (personas: unknown): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'run',
        values: { flow: 'no-such.flow.json', 'no-ensure-chrome': true, personas },
      }),
    });
    const text = await res.text();
    if (res.status === 201) await settle((JSON.parse(text) as { job: { id: string } }).job.id);
    return { status: res.status, text };
  };
  const remembered = async (): Promise<Record<string, { email: string; lastUsedAt: string }[]>> => {
    const res = await fetch(`${base}/api/persona-accounts`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { accounts: Record<string, { email: string; lastUsedAt: string }[]> };
    return body.accounts;
  };

  before(async () => {
    const started = await startUi({ port: 0, open: false });
    base = started.url.replace(/\/$/, '');
    close = started.close;
  });
  after(() => close());

  it('has nothing to offer before a run has been started with an account', async () => {
    assert.equal(existsSync(storeFile), false);
    assert.deepEqual(await remembered(), {});
  });

  it('records the address a started run signs in as, keyed as the command layer keys it', async () => {
    const started = await start({ '<first account>': { email: 'one@x.test', password: 'pw-never-stored' } });
    assert.equal(started.status, 201, started.text);

    const accounts = await remembered();
    assert.deepEqual((accounts['FIRST_ACCOUNT'] ?? []).map((one) => one.email), ['one@x.test']);

    // Neither the route nor the file it reads carries the other half — there
    // is no field for it, which is the point of the store taking label and
    // address rather than a persona map.
    const answer = await (await fetch(`${base}/api/persona-accounts`)).text();
    assert.ok(!answer.includes('pw-never-stored'), 'no password value in the answer');
    assert.ok(!answer.includes('password'), 'not even the field name');
    assert.ok(!readFileSync(storeFile, 'utf8').includes('pw-never-stored'), 'nor on disk');
  });

  it('offers the most recent first, and does not duplicate a re-used address', async () => {
    assert.equal((await start({ FIRST_ACCOUNT: { email: 'two@x.test', password: 'pw2' } })).status, 201);
    assert.equal((await start({ FIRST_ACCOUNT: { email: 'one@x.test', password: 'pw3' } })).status, 201);

    assert.deepEqual(
      ((await remembered())['FIRST_ACCOUNT'] ?? []).map((one) => one.email),
      ['one@x.test', 'two@x.test'],
    );
  });

  it('learns nothing from a submission it refused', async () => {
    // A half-filled account is a 400 from `buildEnvOverlay`, before any job
    // exists. Nothing started, so nothing is remembered.
    const refused = await start({ SECOND_ACCOUNT: { email: 'two@x.test', password: '' } });
    assert.equal(refused.status, 400);
    assert.ok(!(await remembered())['SECOND_ACCOUNT'], 'a refusal teaches the store nothing');
  });
});
