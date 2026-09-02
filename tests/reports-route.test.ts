/**
 * The panel's `/reports/` route (`src/ui/server.ts`).
 *
 * A catalog report links its per-case workbooks and recordings RELATIVELY, so
 * the panel serves the `reports/` folder as a folder rather than through
 * `/view?path=…`. What matters here is the confinement: the route must hand
 * out exactly the files the writer produces — the report and one level of
 * media beneath it — and nothing outside the folder, however the path is
 * spelled. Runs against a real listening server in a temp working directory;
 * every test file is its own process, so `chdir` reaches nothing else.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = mkdtempSync(join(tmpdir(), 'wow-reports-route-'));
process.chdir(cwd);
mkdirSync(join(cwd, 'reports', 'run-media'), { recursive: true });
writeFileSync(join(cwd, 'reports', 'run.html'), '<!doctype html><title>run</title>', 'utf8');
writeFileSync(join(cwd, 'reports', 'run-media', 'pl-01-01.xlsx'), Buffer.from('PK-stand-in'));
writeFileSync(join(cwd, 'reports', 'run-media', 'pl-01-01.webm'), Buffer.from('webm-stand-in'));
writeFileSync(join(cwd, 'secret.txt'), 'not for serving', 'utf8');
mkdirSync(join(cwd, 'reports', 'a', 'b'), { recursive: true });
writeFileSync(join(cwd, 'reports', 'a', 'b', 'deep.html'), 'too deep', 'utf8');

const { startUi } = await import('../src/ui/server.js');

let base = '';
let close: () => void = () => undefined;

describe('/reports/ serves the catalog reports folder as a folder', () => {
  before(async () => {
    const started = await startUi({ port: 0, open: false });
    base = started.url.replace(/\/$/, '');
    close = started.close;
  });
  after(() => close());

  it('hands out the report as HTML', async () => {
    const res = await fetch(`${base}/reports/run.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await res.text(), '<!doctype html><title>run</title>');
  });

  it('hands out the media beneath it with the type Excel and a player expect', async () => {
    const xlsx = await fetch(`${base}/reports/run-media/pl-01-01.xlsx`);
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const webm = await fetch(`${base}/reports/run-media/pl-01-01.webm`);
    assert.equal(webm.status, 200);
    assert.equal(webm.headers.get('content-type'), 'video/webm');
  });

  it('a relative link inside the report resolves to its sibling — the reason the route exists', async () => {
    // What the browser does with href="run-media/pl-01-01.xlsx" on /reports/run.html.
    const resolved = new URL('run-media/pl-01-01.xlsx', `${base}/reports/run.html`).toString();
    assert.equal(resolved, `${base}/reports/run-media/pl-01-01.xlsx`);
    assert.equal((await fetch(resolved)).status, 200);
  });

  it('refuses anything outside the folder, however the climb is spelled', async () => {
    for (const path of ['/reports/%2e%2e/secret.txt', '/reports/..%2Fsecret.txt', '/reports/run-media/%2e%2e/%2e%2e/secret.txt']) {
      const res = await fetch(`${base}${path}`);
      assert.ok(res.status === 403 || res.status === 404, `${path} → ${res.status}`);
      assert.ok(!(await res.text()).includes('not for serving'), path);
    }
  });

  it('refuses a path deeper than the writer produces, and 404s a missing file', async () => {
    assert.equal((await fetch(`${base}/reports/a/b/deep.html`)).status, 403);
    assert.equal((await fetch(`${base}/reports/`)).status, 403);
    assert.equal((await fetch(`${base}/reports/nope.html`)).status, 404);
  });
});
