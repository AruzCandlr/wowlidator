/**
 * Saved repositories — the registry behind `context add` and the wowUI
 * dropdown. Entirely unit-tier: file read/write and string work, the
 * `context-engine.test.ts` reasoning.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  graphFileFor,
  listRepos,
  mergedScanInputs,
  resolveRepo,
  slugFor,
  upsertRepo,
  type RepoEntry,
} from '../src/context/repo-registry.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wow-repo-registry-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(path: string, overrides: Partial<RepoEntry> = {}): RepoEntry {
  return {
    slug: slugFor(path),
    path: resolve(path),
    indexedAt: '2026-08-17T00:00:00.000Z',
    nodes: 42,
    ...overrides,
  };
}

describe('slugFor', () => {
  it('is stable for a path and readable', () => {
    const slug = slugFor('/tmp/some/app-under-test');
    assert.equal(slug, slugFor('/tmp/some/app-under-test'));
    assert.ok(slug.startsWith('app-under-test-'));
  });

  it('distinguishes two repos sharing a basename', () => {
    // Two checkouts named "app" must not share a graph file — that is the
    // exact overwrite problem the registry exists to end.
    assert.notEqual(slugFor('/a/app'), slugFor('/b/app'));
  });

  it('names the graph file from the slug, under the registry dir', () => {
    const slug = slugFor('/a/app');
    assert.ok(graphFileFor(slug, dir).endsWith(`${slug}.graph.json`));
  });
});

describe('the registry file', () => {
  it('starts empty, remembers an upsert, and replaces by slug', async () => {
    assert.deepEqual(await listRepos(dir), []);

    await upsertRepo(entry('/a/app'), dir);
    assert.equal((await listRepos(dir)).length, 1);

    // Re-adding the same path is a re-scan, not a duplicate.
    await upsertRepo(entry('/a/app', { nodes: 99 }), dir);
    const repos = await listRepos(dir);
    assert.equal(repos.length, 1);
    assert.equal(repos[0]!.nodes, 99);

    await upsertRepo(entry('/b/other'), dir);
    assert.equal((await listRepos(dir)).length, 2);
  });

  it('carries the scan inputs, so a re-scan keeps its endpoints and tables', async () => {
    await upsertRepo(entry('/c/specced', { openapi: './openapi.yaml', dbSchema: './schema.sql' }), dir);
    const found = await resolveRepo('/c/specced', dir);
    assert.equal(found?.openapi, './openapi.yaml');
    assert.equal(found?.dbSchema, './schema.sql');
  });

  it('resolves by slug and by path, and answers null for the unknown', async () => {
    const saved = entry('/a/app');
    assert.equal((await resolveRepo(saved.slug, dir))?.path, saved.path);
    assert.equal((await resolveRepo('/a/app', dir))?.slug, saved.slug);
    // null, not a guess — the caller must fail loudly on an explicit
    // selection that names nothing.
    assert.equal(await resolveRepo('no-such-repo', dir), null);
  });

  it('a bare re-add keeps the remembered scan inputs — the Re-scan button posts only the path', async () => {
    // Add with --db-schema…
    await upsertRepo(entry('/d/rescan', { dbSchema: './schema.sql' }), dir);

    // …then re-add without flags, the way `context add` now does it: resolve
    // the existing entry, merge, and upsert the merged inputs. Dropping the
    // schema here is how a rebuilt graph loses every table node.
    const merged = mergedScanInputs(await resolveRepo('/d/rescan', dir), {});
    await upsertRepo(entry('/d/rescan', merged), dir);

    const kept = await resolveRepo('/d/rescan', dir);
    assert.equal(kept?.dbSchema, './schema.sql');
    assert.equal(kept?.openapi, undefined, 'an input never passed is never invented');
  });

  it('an explicitly passed scan input still wins over the remembered one', async () => {
    await upsertRepo(entry('/e/respecced', { openapi: './openapi.yaml' }), dir);
    const merged = mergedScanInputs(await resolveRepo('/e/respecced', dir), {
      openapi: './v2/openapi.yaml',
    });
    assert.equal(merged.openapi, './v2/openapi.yaml');

    // And a first add — no existing entry — invents nothing.
    const fresh = mergedScanInputs(null, {});
    assert.equal(fresh.openapi, undefined);
    assert.equal(fresh.dbSchema, undefined);
  });

  it('reads a corrupt registry as empty rather than crashing the command', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'wow-repo-broken-'));
    try {
      await writeFile(join(broken, 'repos.json'), '{not json', 'utf8');
      assert.deepEqual(await listRepos(broken), []);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});
