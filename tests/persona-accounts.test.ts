/**
 * The panel's memory of the accounts it has run as (`src/ui/persona-accounts.ts`).
 *
 * One rule dominates the file and therefore this test: **the address is
 * remembered, the password never is**. A store holding both halves would be a
 * credential on disk that can sign in on its own, sitting beside a server that
 * binds to a port; an address alone opens nothing. So the API boundary takes
 * `{ label, email }`, and the tests below assert that a password-shaped extra
 * property survives neither a write nor a read — the shape is the guarantee,
 * not the caller's good manners.
 *
 * Everything else here is the small-local-file discipline the ledger and the
 * cache already keep: newest first, re-use moves to the front, a per-label cap,
 * temp-file-then-rename, and a corrupt file that reads as "nothing remembered"
 * rather than failing a run. Pure: a temp directory, no server, no browser.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_ACCOUNTS_PER_LABEL,
  PERSONA_ACCOUNTS_VERSION,
  PersonaAccountStore,
  readAccountsFrom,
} from '../src/ui/persona-accounts.js';
import { personasValueToMap } from '../src/ui/commands.js';

const dir = mkdtempSync(join(tmpdir(), 'wow-persona-accounts-'));
let n = 0;
/** A store of its own per test — this is a file, and order must not matter. */
function store(): PersonaAccountStore {
  n += 1;
  return new PersonaAccountStore(join(dir, `store-${n}`, 'persona-accounts.json'));
}

/** Swallows the one stderr line the store writes when a file is unusable. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = () => true;
  try {
    return await run();
  } finally {
    (process.stderr as unknown as { write: unknown }).write = write;
  }
}

describe('the accounts the panel remembers', () => {
  it('round-trips a label and its address, and nothing else', async () => {
    const s = store();
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'one@x.test' }], '2026-09-04T10:00:00.000Z');

    assert.deepEqual(await s.read(), {
      FIRST_ACCOUNT: [{ email: 'one@x.test', lastUsedAt: '2026-09-04T10:00:00.000Z' }],
    });
    const onDisk = JSON.parse(readFileSync(s.file, 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk['version'], PERSONA_ACCOUNTS_VERSION);
    // Two keys per entry. A third would be the beginning of a credential.
    assert.deepEqual(
      Object.keys(((onDisk['accounts'] as Record<string, { email: string }[]>)['FIRST_ACCOUNT'] ?? [])[0] ?? {}),
      ['email', 'lastUsedAt'],
    );
  });

  it('offers the most recently used first', async () => {
    const s = store();
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'older@x.test' }], '2026-09-01T10:00:00.000Z');
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'newer@x.test' }], '2026-09-04T10:00:00.000Z');

    const accounts = await s.read();
    assert.deepEqual(
      (accounts['FIRST_ACCOUNT'] ?? []).map((one) => one.email),
      ['newer@x.test', 'older@x.test'],
    );
  });

  it('moves a re-used address back to the front instead of duplicating it', async () => {
    const s = store();
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'a@x.test' }], '2026-09-01T10:00:00.000Z');
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'b@x.test' }], '2026-09-02T10:00:00.000Z');
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'A@x.test' }], '2026-09-03T10:00:00.000Z');

    const list = (await s.read())['FIRST_ACCOUNT'] ?? [];
    assert.deepEqual(list.map((one) => one.email), ['A@x.test', 'b@x.test']);
    assert.equal(list[0]?.lastUsedAt, '2026-09-03T10:00:00.000Z', 'the stamp is the last run, not the first');
  });

  it('keeps only the last few per label, so the file and the dropdown stay bounded', async () => {
    const s = store();
    for (let i = 0; i <= MAX_ACCOUNTS_PER_LABEL; i += 1) {
      await s.remember([{ label: 'FIRST_ACCOUNT', email: `a${i}@x.test` }], `2026-09-0${1}T10:00:0${0}.000Z`);
    }
    const list = (await s.read())['FIRST_ACCOUNT'] ?? [];
    assert.equal(list.length, MAX_ACCOUNTS_PER_LABEL);
    assert.equal(list[0]?.email, `a${MAX_ACCOUNTS_PER_LABEL}@x.test`, 'the newest is kept');
    assert.ok(!list.some((one) => one.email === 'a0@x.test'), 'the oldest is dropped');
  });

  it('keys labels exactly as the command layer does, so one account is one key', async () => {
    const s = store();
    await s.remember([{ label: '<second account>', email: 'two@x.test' }], '2026-09-04T10:00:00.000Z');
    await s.remember([{ label: 'second-account', email: 'two@x.test' }], '2026-09-04T11:00:00.000Z');

    const accounts = await s.read();
    assert.deepEqual(Object.keys(accounts), ['SECOND_ACCOUNT']);
    assert.equal((accounts['SECOND_ACCOUNT'] ?? []).length, 1, 'three spellings, one account');
    // …and it is the same key the submission itself is validated into, or the
    // launcher would look up a memory that was filed under another name.
    assert.deepEqual(
      Object.keys(personasValueToMap({ '<second account>': { email: 'two@x.test', password: 'pw' } })),
      Object.keys(accounts),
    );
  });

  it('drops a reference it cannot use rather than writing a broken one', async () => {
    const s = store();
    await s.remember(
      [
        { label: '', email: 'nolabel@x.test' },
        { label: 'FIRST_ACCOUNT', email: '   ' },
        { label: 'FIRST_ACCOUNT', email: 'has a space@x.test' },
        { label: 'FIRST_ACCOUNT', email: 42 as unknown as string },
      ],
      '2026-09-04T10:00:00.000Z',
    );
    assert.deepEqual(await s.read(), {});
  });

  it('reads a corrupt, truncated or foreign file as nothing remembered', async () => {
    for (const content of ['', '{ not json', '[]', '{"version":99,"accounts":{"A":[{"email":"a@x.test"}]}}']) {
      const s = store();
      mkdirSync(join(s.file, '..'), { recursive: true });
      writeFileSync(s.file, content, 'utf8');
      assert.deepEqual(await quietly(() => s.read()), {}, content.slice(0, 20));
    }
    // A file that is unreadable is not different from one that is absent.
    assert.deepEqual(readAccountsFrom('{"version":1,"accounts":{"A":"not a list"}}'), {});
  });

  it('never lets a password reach the file, whatever the caller hands it', async () => {
    const s = store();
    // The typed API has no password field; this is what an accidental spread
    // of a persona entry would look like at runtime, which is the case the
    // shape has to survive.
    await s.remember(
      [{ label: 'FIRST_ACCOUNT', email: 'one@x.test', password: 'hunter2-should-never-land' } as never],
      '2026-09-04T10:00:00.000Z',
    );

    const raw = readFileSync(s.file, 'utf8');
    assert.ok(!raw.includes('hunter2-should-never-land'), 'no password value in the file');
    assert.ok(!raw.includes('password'), 'not even the field name');
    assert.ok(!JSON.stringify(await s.read()).includes('hunter2-should-never-land'), 'nor in the read-back');

    // And a file that already had one — hand-edited, or written by a future
    // bug — is read back without it, so it can reach neither a page nor the
    // next write.
    writeFileSync(
      s.file,
      JSON.stringify({
        version: PERSONA_ACCOUNTS_VERSION,
        accounts: { FIRST_ACCOUNT: [{ email: 'one@x.test', lastUsedAt: '2026-09-04T10:00:00.000Z', password: 'leaked' }] },
      }),
      'utf8',
    );
    assert.ok(!JSON.stringify(await s.read()).includes('leaked'));
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'two@x.test' }], '2026-09-04T11:00:00.000Z');
    assert.ok(!readFileSync(s.file, 'utf8').includes('leaked'), 'and the rewrite does not carry it forward');
  });

  it('writes through a temp file and leaves none behind', async () => {
    const s = store();
    await s.remember([{ label: 'FIRST_ACCOUNT', email: 'one@x.test' }], '2026-09-04T10:00:00.000Z');
    const left = readdirSync(join(s.file, '..')).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(left, []);
  });

  it('cannot fail a run: an unwritable store is a stderr line, not a throw', async () => {
    const blocked = join(dir, 'a-file-not-a-directory');
    writeFileSync(blocked, 'x', 'utf8');
    const s = new PersonaAccountStore(join(blocked, 'persona-accounts.json'));
    await quietly(async () => {
      await assert.doesNotReject(() => s.remember([{ label: 'FIRST_ACCOUNT', email: 'one@x.test' }]));
      assert.deepEqual(await s.read(), {});
    });
  });
});
