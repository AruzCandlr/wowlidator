/**
 * A catalog resume rebuilt from the ledger alone must not run without the
 * account's password (`src/ui/server.ts`, `/api/catalog-runs/resume`).
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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
delete process.env['WOWLIDATOR_AS'];

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
