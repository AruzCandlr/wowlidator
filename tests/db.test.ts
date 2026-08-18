/**
 * Database verification: the client seam, the state-tier checks, redaction of
 * rows, and the grounding gate.
 *
 * Almost everything here runs against a scripted `DbClient` stub — the seam
 * exists precisely so this suite runs offline, the `HealerModel` argument.
 * The stub answers the two SQL shapes `DbActions` emits (a count, a select),
 * which is acceptable at this tier because the SQL itself is ours; whether
 * *real* Postgres accepts it is the gated tier's question
 * (`WOWLIDATOR_DB_TESTS=1`, a disposable database — gated rather than
 * auto-skipped because touching a real database should not happen unasked).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DbGroundingError,
  DbUnavailableError,
  connectDb,
  isLoopbackDsn,
  maskDsn,
  type DbClient,
  type DbResult,
  type DbSchema,
} from '../src/db/client.js';
import {
  DbActions,
  looseEquals,
  parseDbConditions,
  quoteIdent,
} from '../src/db/db-actions.js';
import { redactRow, redactValue, redactWhereSummary } from '../src/db/redact-row.js';
import { REDACTED } from '../src/api/redact.js';
import { VariableStore } from '../src/api/variables.js';
import {
  BROWSER_FREE_ACTIONS,
  BACKEND_TIER_ACTIONS,
  ProofBundleBuilder,
} from '../src/engine/proof-bundle.js';
import { hasAssertion, isBrowserFree, runApiFlow, type Flow } from '../src/engine/runner.js';
import type { ApiResponse, ApiRequestSpec, ApiTransport } from '../src/api/api-client.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import { EXIT, classifyError, exitCodeFor } from '../src/cli/exit.js';

const SCHEMA: DbSchema = {
  source: 'introspection',
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, pk: true },
        { name: 'status', type: 'text', nullable: false, pk: false },
        { name: 'password_hash', type: 'text', nullable: true, pk: false },
      ],
      pk: ['id'],
      references: [],
    },
    {
      name: 'users',
      columns: [{ name: 'id', type: 'uuid', nullable: false, pk: true }],
      pk: ['id'],
      references: [],
    },
    // A table outside the current schema, addressed the way introspection
    // names it — the first real target (cnext-hrms, `benefit_management.*`)
    // kept every table it writes out of `public`.
    {
      name: 'benefit_management.benefit_plan',
      columns: [
        { name: 'id', type: 'integer', nullable: false, pk: true },
        { name: 'status', type: 'text', nullable: false, pk: false },
      ],
      pk: ['id'],
      references: [],
    },
  ],
};

/**
 * Scripted client. `counts`/`rows` are mutable so a test can "write" between
 * steps; `statements` is the pg_stat_statements table, `null` meaning the
 * extension is absent.
 */
class StubDbClient implements DbClient {
  readonly id = 'stub';
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  counts: Record<string, number> = {};
  rows: Record<string, Record<string, unknown>[]> = {};
  statements: { queryid: string; query: string; calls: number }[] | null = null;
  closed = false;

  async query(sql: string, params: readonly unknown[]): Promise<DbResult> {
    this.queries.push({ sql, params });
    if (sql.includes('pg_stat_statements')) {
      if (this.statements === null) throw new Error('relation "pg_stat_statements" does not exist');
      return { rows: this.statements.map((s) => ({ ...s })), rowCount: this.statements.length, durationMs: 1 };
    }
    const table = (/FROM ((?:"[^"]+"\.)?"[^"]+")/.exec(sql)?.[1] ?? '').replace(/"/g, '');
    if (sql.includes('count(*)')) {
      const hasWhere = sql.includes('WHERE');
      const n = hasWhere
        ? String(this.matching(table, params).length)
        : String(this.counts[table] ?? this.rows[table]?.length ?? 0);
      return { rows: [{ n }], rowCount: 1, durationMs: 1 };
    }
    return { rows: this.matching(table, params), rowCount: 0, durationMs: 1 };
  }

  /** Cheap where-matching: any row containing every param as a cell value. */
  private matching(table: string, params: readonly unknown[]): Record<string, unknown>[] {
    const all = this.rows[table] ?? [];
    if (params.length === 0) return all;
    return all.filter((row) =>
      params.every((param) => Object.values(row).some((cell) => String(cell) === String(param))),
    );
  }

  async introspect(): Promise<DbSchema> {
    return SCHEMA;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function harness(client: DbClient): { db: DbActions; bundle: ProofBundleBuilder; defects: string[] } {
  const bundle = new ProofBundleBuilder({ name: 'db-test' });
  const defects: string[] = [];
  const db = new DbActions({
    db: null,
    client,
    bundle,
    variables: new VariableStore(),
    recordDefect: (_category, _severity, title) => defects.push(title),
  });
  return { db, bundle, defects };
}

// --- pure helpers -----------------------------------------------------------

describe('db building blocks', () => {
  it('quotes identifiers by doubling, membership being the real gate', () => {
    assert.equal(quoteIdent('orders'), '"orders"');
    assert.equal(quoteIdent('we"ird'), '"we""ird"');
  });

  it('parses the flat condition form, refusing what it cannot read', () => {
    assert.deepEqual(parseDbConditions('id = {{orderId}} AND status = pending'), {
      id: '{{orderId}}',
      status: 'pending',
    });
    assert.deepEqual(parseDbConditions("status = 'has AND inside'"), { status: 'has AND inside' });
    assert.deepEqual(parseDbConditions('deleted_at = NULL'), { deleted_at: null });
    assert.deepEqual(parseDbConditions(''), {});
    assert.equal(parseDbConditions('no equals sign'), null);
  });

  it('compares cell values stringily, dates as ISO', () => {
    assert.equal(looseEquals('42', 42), true);
    assert.equal(looseEquals(42, '42'), true);
    assert.equal(looseEquals(null, null), true);
    assert.equal(looseEquals('x', null), false);
    assert.equal(looseEquals('2026-01-01T00:00:00.000Z', new Date('2026-01-01')), true);
  });

  it('masks sensitive columns and describes what it cannot render', () => {
    const row = redactRow({ id: 42, password_hash: 'hunter2', blob: new Uint8Array(16) });
    assert.equal(row['id'], '42');
    assert.equal(row['password_hash'], REDACTED);
    assert.equal(row['blob'], '[bytes: 16]');
    assert.equal(redactValue('session_token', 'abc'), REDACTED);
    assert.match(redactWhereSummary({ id: 7, api_key: 'sk-live' }), /id = 7 AND api_key = \[redacted\]/);
  });
});

// --- the connection guards --------------------------------------------------

describe('the connection guards', () => {
  it('refuses to run with nothing configured, naming the env var', async () => {
    await assert.rejects(connectDb({}), /database unavailable: no connection is configured/);
  });

  it('refuses a remote host without the explicit opt-in', async () => {
    await assert.rejects(
      connectDb({ url: 'postgres://user:secret@db.prod.example:5432/app' }),
      /--db-remote-ok/,
    );
  });

  it('masks the password wherever a DSN is shown', () => {
    assert.equal(
      maskDsn('postgres://user:secret@db.example:5432/app'),
      'postgres://user:***@db.example:5432/app',
    );
    assert.equal(maskDsn('not a url'), '(unparseable connection string)');
  });

  it('knows loopback when it sees it', () => {
    assert.equal(isLoopbackDsn('postgres://localhost/db'), true);
    assert.equal(isLoopbackDsn('postgres://127.0.0.1:5433/db'), true);
    assert.equal(isLoopbackDsn('postgres://db.internal:5432/db'), false);
  });

  it('classifies every database-unavailable shape as environment, never failed', () => {
    assert.equal(classifyError(new DbUnavailableError('anything')), EXIT.environment);
    assert.equal(
      exitCodeFor({ status: 'error', error: 'database unavailable: the "pg" driver is not installed' }),
      EXIT.environment,
    );
  });
});

// --- the state tier, against the stub ---------------------------------------

describe('DbActions state checks', () => {
  it('proves a row keyed by a saved variable, and records redacted evidence', async () => {
    const client = new StubDbClient();
    client.rows['orders'] = [{ id: '42', status: 'pending', password_hash: 'hunter2-secret' }];

    const { db, bundle } = harness(client);
    const variables = new VariableStore();
    variables.set('orderId', '42');
    const keyed = new DbActions({
      db: null,
      client,
      bundle,
      variables,
    });

    await keyed.expectDbRow({
      table: 'orders',
      where: { id: '{{orderId}}' },
      values: { status: 'pending' },
      intent: 'the order the API returned is persisted',
    });
    void db;

    // The interpolated variable reached the parameterized query — causal keying.
    const withParams = client.queries.find((q) => q.params.length > 0)!;
    assert.deepEqual(withParams.params, ['42']);

    const step = bundle.steps[bundle.steps.length - 1]!;
    assert.equal(step.status, 'passed');
    assert.equal(step.db?.kind, 'row');
    assert.match(step.db?.where ?? '', /id = 42/);
    assert.equal(step.db?.rows?.[0]?.['password_hash'], REDACTED);
    assert.match(step.db?.note ?? '', /while this flow ran/);

    // The leak test, end to end: the raw value must not survive into HTML.
    const html = renderReport(bundle.finish());
    assert.ok(!html.includes('hunter2-secret'), 'a password column value must never reach the report');
  });

  it('polls through eventual consistency and puts the wait on the record', async () => {
    const client = new StubDbClient();
    client.rows['orders'] = [];
    setTimeout(() => {
      client.rows['orders'] = [{ id: '9', status: 'done' }];
    }, 400);

    const { db, bundle } = harness(client);
    await db.expectDbRow({ table: 'orders', where: { id: '9' }, timeoutMs: 3_000 });

    const step = bundle.steps[bundle.steps.length - 1]!;
    assert.equal(step.status, 'passed');
    assert.ok((step.db?.polledMs ?? 0) >= 300, 'the eventual-consistency wait is evidence');
  });

  it('fails with the observed count after the budget, filing a backend defect', async () => {
    const client = new StubDbClient();
    client.rows['orders'] = [];
    const { db, bundle, defects } = harness(client);

    await assert.rejects(
      db.expectDbRow({ table: 'orders', where: { id: 'missing' }, timeoutMs: 400 }),
      /found 0/,
    );
    const step = bundle.steps[bundle.steps.length - 1]!;
    assert.equal(step.status, 'failed');
    assert.deepEqual(defects, ['DB check failed: expectDbRow']);
  });

  it('diffs against a named snapshot, and refuses to diff against nothing', async () => {
    const client = new StubDbClient();
    client.counts = { orders: 2, users: 5 };
    const { db, bundle, defects } = harness(client);

    await db.dbSnapshot({ tables: ['orders', 'users'] });
    client.counts = { orders: 3, users: 5 };

    await db.expectDbDelta({ table: 'orders', delta: 1, timeoutMs: 10 });
    await db.expectDbUnchanged({ tables: ['users'] });

    const unchanged = bundle.steps[bundle.steps.length - 1]!;
    assert.equal(unchanged.status, 'passed');
    assert.match(
      unchanged.db?.note ?? '',
      /count-based/,
      'the same-count-UPDATE blindness is disclosed on the record, not implied away',
    );

    await assert.rejects(
      db.expectDbDelta({ table: 'orders', delta: 1, since: 'nonexistent' }),
      DbGroundingError,
    );
    assert.equal(
      defects.length,
      0,
      'a grounding refusal is the flow’s problem, never an application defect',
    );
  });

  it('catches the accidental write', async () => {
    const client = new StubDbClient();
    client.counts = { users: 5 };
    const { db } = harness(client);

    await db.dbSnapshot({ tables: ['users'] });
    client.counts = { users: 6 };

    await assert.rejects(db.expectDbUnchanged({ tables: ['users'] }), /users \(5 → 6\)/);
  });

  it('addresses a table in another schema as schema.table, quoted part by part', async () => {
    const client = new StubDbClient();
    client.rows['benefit_management.benefit_plan'] = [{ id: 7, status: 'A' }];
    const { db, bundle } = harness(client);

    await db.expectDbRow({ table: 'benefit_management.benefit_plan', where: { id: 7 }, values: { status: 'A' } });

    const step = bundle.steps[bundle.steps.length - 1]!;
    assert.equal(step.status, 'passed');
    // `"benefit_management"."benefit_plan"` — never `"benefit_management.benefit_plan"`,
    // which is a single (nonexistent) identifier.
    assert.ok(client.queries.some((q) => q.sql.includes('"benefit_management"."benefit_plan"')));
    assert.ok(client.queries.every((q) => !q.sql.includes('"benefit_management.benefit_plan"')));
  });

  it('refuses a table or column the schema does not declare, listing what it does', async () => {
    const client = new StubDbClient();
    const { db, defects } = harness(client);

    await assert.rejects(
      db.expectDbRow({ table: 'invoices', where: { id: '1' } }),
      /"invoices" is not in the schema.*orders/s,
    );
    await assert.rejects(
      db.expectDbRow({ table: 'orders', where: { nope: '1' } }),
      /"orders" has no column "nope"/,
    );
    assert.equal(defects.length, 0);
  });

  it('counts statement executions since a snapshot, and blocks when stats are absent', async () => {
    const client = new StubDbClient();
    client.counts = { orders: 0 };
    client.statements = [
      { queryid: '1', query: 'INSERT INTO orders (id) VALUES ($1)', calls: 10 },
      { queryid: '2', query: 'SELECT * FROM orders WHERE id = $1', calls: 100 },
    ];
    const { db, bundle } = harness(client);

    await db.dbSnapshot({ tables: ['orders'] });
    client.statements = [
      { queryid: '1', query: 'INSERT INTO orders (id) VALUES ($1)', calls: 11 },
      { queryid: '2', query: 'SELECT * FROM orders WHERE id = $1', calls: 151 },
    ];

    await db.expectDbCalled({ match: 'INSERT INTO orders', delta: 1 });
    const step = bundle.steps[bundle.steps.length - 1]!;
    assert.equal(step.status, 'passed');
    assert.match(step.db?.note ?? '', /correlational/);

    // The N+1 storm reads as a count.
    await assert.rejects(
      db.expectDbCalled({ match: 'SELECT * FROM orders', delta: 1, timeoutMs: 300 }),
      /observed 51/,
    );

    // Extension absent at snapshot time → blocked, an environment fact.
    const bare = new StubDbClient();
    bare.counts = { orders: 0 };
    const second = harness(bare);
    await second.db.dbSnapshot({ tables: ['orders'] });
    await assert.rejects(
      second.db.expectDbCalled({ match: 'INSERT' }),
      /database unavailable: statement statistics were not readable/,
    );
    assert.equal(second.defects.length, 0, 'no app defect for a stats extension that is off');
  });
});

// --- the flow model and the browser-free path --------------------------------

class StubTransport implements ApiTransport {
  readonly id = 'stub-transport';
  async send(_spec: ApiRequestSpec): Promise<ApiResponse> {
    const body = JSON.stringify({ id: '42' });
    return {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      body,
      durationMs: 3,
      sizeBytes: body.length,
    };
  }
}

describe('DB steps in the flow model', () => {
  it('registers in the action sets and as assertions', () => {
    for (const action of ['dbSnapshot', 'expectDbRow', 'expectDbDelta', 'expectDbUnchanged', 'expectDbCalled']) {
      assert.ok(BROWSER_FREE_ACTIONS.has(action), `${action} needs no browser`);
      assert.ok(BACKEND_TIER_ACTIONS.has(action), `${action} is backend-tier`);
    }
    assert.equal(hasAssertion([{ action: 'expectDbRow', table: 't', where: { id: '1' } }]), true);
    assert.equal(hasAssertion([{ action: 'dbSnapshot', tables: ['t'] }]), false, 'a snapshot claims nothing');
  });

  it('keeps a request+DB flow browser-free, and runs it end to end with shared variables', async () => {
    const flow: Flow = {
      name: 'hybrid-browser-free',
      baseUrl: 'https://api.test',
      setup: [{ action: 'dbSnapshot', tables: ['orders'] }],
      steps: [
        {
          action: 'request',
          method: 'POST',
          url: '/api/orders',
          save: { orderId: '$.id' },
          intent: 'create the order',
        },
        { action: 'expectStatus', status: 201 },
        {
          action: 'expectDbRow',
          table: 'orders',
          where: { id: '{{orderId}}' },
          values: { status: 'pending' },
          intent: 'the id the API returned is the row that exists',
        },
        { action: 'expectDbDelta', table: 'orders', delta: 0 },
      ],
    };
    assert.equal(isBrowserFree(flow), true);

    const client = new StubDbClient();
    client.counts = { orders: 1 };
    client.rows['orders'] = [{ id: '42', status: 'pending' }];

    const bundle = await runApiFlow(flow, {
      transport: new StubTransport(),
      dbClient: client,
      historyPath: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    // One store: the id the request saved keyed the DB check.
    const withParams = client.queries.find((q) => q.params.length > 0)!;
    assert.deepEqual(withParams.params, ['42']);
    // The masked snapshot of what was saved is on the bundle.
    assert.deepEqual(bundle.variables, { orderId: '42' });
    // Every step of this flow is backend-side, and the db counters agree.
    assert.equal(bundle.summary.frontend.steps, 0);
    assert.equal(bundle.summary.backend.steps, bundle.summary.totalSteps);
    assert.equal(bundle.summary.dbChecks, 3);
    assert.equal(bundle.summary.dbFailures, 0);
    // Ownership follows the runner's own rule: only a connection this run
    // *opened* is this run's to close. An injected client is the caller's.
    assert.equal(client.closed, false);
  });

  it('classifies an unconfigured database as an error, not an app failure', async () => {
    const flow: Flow = {
      name: 'db-unconfigured',
      steps: [
        { action: 'request', method: 'GET', url: 'https://api.test/x' },
        { action: 'expectDbRow', table: 'orders', where: { id: '1' } },
      ],
    };

    const bundle = await runApiFlow(flow, {
      transport: new StubTransport(),
      db: null,
      historyPath: null,
    });

    assert.equal(bundle.status, 'error');
    const step = bundle.steps.find((s) => s.action === 'expectDbRow')!;
    assert.equal(step.status, 'error', 'a harness fact, not a test failure');
    assert.match(step.error ?? '', /database unavailable/);
    assert.equal(
      bundle.defects.some((d) => d.title.includes('expectDbRow')),
      false,
    );
    assert.equal(exitCodeFor(bundle), EXIT.environment);
  });
});

// --- the real thing, gated ---------------------------------------------------

const dbTests = process.env['WOWLIDATOR_DB_TESTS'] === '1';
const dbUrl = process.env['WOWLIDATOR_DB_URL'];

describe(
  'against a real Postgres (WOWLIDATOR_DB_TESTS=1)',
  { skip: dbTests && dbUrl ? false : 'set WOWLIDATOR_DB_TESTS=1 and WOWLIDATOR_DB_URL to run — touches a real database' },
  () => {
    it('connects read-only: introspection works, a write is refused by the session', async () => {
      const client = await connectDb({ url: dbUrl!, remoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1' });
      try {
        const schema = await client.introspect();
        assert.ok(Array.isArray(schema.tables));
        // Layer 2 holds even if layer 1 (the statement builder) were bypassed.
        await assert.rejects(
          client.query('CREATE TABLE wowlidator_should_never_exist (id int)', []),
          /read-only/i,
        );
      } finally {
        await client.close();
      }
    });
  },
);

// --- count as a variable: the API-number-vs-database-number cross-check ------

describe('expectDbRow count as a string', () => {
  function countHarness(count: number): { db: DbActions; bundle: ProofBundleBuilder; store: VariableStore } {
    const client = new StubDbClient();
    client.counts['orders'] = count;
    const bundle = new ProofBundleBuilder({ name: 'db-test' });
    const store = new VariableStore();
    const db = new DbActions({ db: null, client, bundle, variables: store });
    return { db, bundle, store };
  }

  it('a {{variable}} count interpolates and compares — the cross-check passes when they agree', async () => {
    const { db, bundle, store } = countHarness(98);
    store.set('persons', '98');
    await db.expectDbRow({ table: 'orders', where: {}, count: '{{persons}}', timeoutMs: 50 });
    assert.equal(bundle.steps[0]?.status, 'passed');
  });

  it('and fails when they disagree', async () => {
    const { db, bundle, store } = countHarness(97);
    store.set('persons', '98');
    await assert.rejects(
      () => db.expectDbRow({ table: 'orders', where: {}, count: '{{persons}}', timeoutMs: 50 }),
      /expected exactly 98 row/,
    );
    assert.equal(bundle.steps[0]?.status, 'failed');
  });

  it('an unknown variable is an error, never an empty count', async () => {
    const { db } = countHarness(98);
    await assert.rejects(
      () => db.expectDbRow({ table: 'orders', where: {}, count: '{{nobody}}', timeoutMs: 50 }),
      /nobody/,
    );
  });

  it('a count that does not resolve to a number fails loudly, naming both forms', async () => {
    const { db, store } = countHarness(98);
    store.set('persons', 'many');
    await assert.rejects(
      () => db.expectDbRow({ table: 'orders', where: {}, count: '{{persons}}', timeoutMs: 50 }),
      /not a number/,
    );
  });

  it('an empty where with a numeric count reads the whole table', async () => {
    const { db, bundle } = countHarness(36);
    await db.expectDbRow({ table: 'orders', where: {}, count: 36, timeoutMs: 50 });
    assert.equal(bundle.steps[0]?.status, 'passed');
  });
});

// --- the values half of a row check must be half the story -------------------

describe('expectDbRow failure wording with a values filter', () => {
  it('names both halves: the values expected, and how many rows matched the where', async () => {
    // DB_07_01 live: 1 row matched the where and 0 held the expected values,
    // and the old message — "where rule_id = …; found 0" — read as "the row
    // is missing" when the row was there and merely un-updated.
    const client = new StubDbClient();
    client.rows['orders'] = [{ id: '42', status: 'pending' }];

    const { db, bundle } = harness(client);
    await assert.rejects(
      () =>
        db.expectDbRow({
          table: 'orders',
          where: { id: '42' },
          values: { status: 'paid' },
          timeoutMs: 100,
        }),
      (error: Error) => {
        assert.match(error.message, /holding status = paid/);
        assert.match(error.message, /found 0 of 1 row\(s\) matching the where/);
        return true;
      },
    );
    const step = bundle.steps[bundle.steps.length - 1]!;
    assert.match(step.db?.expected ?? '', /holding status = paid/);
    assert.match(step.db?.observed ?? '', /0 of 1 row\(s\)/);
  });

  it('a check with no values keeps the plain count wording', async () => {
    const client = new StubDbClient();
    client.rows['orders'] = [];
    const { db } = harness(client);
    await assert.rejects(
      () => db.expectDbRow({ table: 'orders', where: { id: '9' }, timeoutMs: 100 }),
      (error: Error) => {
        assert.match(error.message, /expected at least 1 row in "orders" where id = 9; found 0 row\(s\) \(/);
        assert.doesNotMatch(error.message, /holding|matching the where/);
        return true;
      },
    );
  });
});


/**
 * Which side a failed database check belongs to.
 *
 * "The row is not there" is one observation with two candidate causes that go
 * to different people: the backend refused the write, or nothing ever sent
 * one. The second is not hypothetical — it is what a screen that keeps its
 * state in the browser looks like from the database's point of view, and
 * against one of those a DB assertion files a high backend defect on every
 * run of a feature that works exactly as built.
 */
describe('a failed DB check is attributed by what the page actually sent', () => {
  function attributed(witness: { observing: boolean; total: number; mutating: number }) {
    const bundle = new ProofBundleBuilder({ name: 'db-attribution' });
    const filed: { category: string; severity: string; title: string; detail: string }[] = [];
    const db = new DbActions({
      db: null,
      client: (() => {
        const client = new StubDbClient();
        client.counts = { orders: 7 };
        return client;
      })(),
      bundle,
      variables: new VariableStore(),
      writeWitness: () => witness,
      recordDefect: (category, severity, title, detail) =>
        filed.push({ category, severity, title, detail }),
    });
    return { db, filed };
  }

  it('blames the backend when the page did send writes', async () => {
    const { db, filed } = attributed({ observing: true, total: 12, mutating: 3 });
    await db.dbSnapshot({ tables: ['orders'] });
    await assert.rejects(db.expectDbDelta({ table: 'orders', delta: 1, timeoutMs: 10 }));
    assert.equal(filed[0]?.category, 'backend');
    assert.equal(filed[0]?.severity, 'high');
  });

  it('does not blame the backend when nothing asked it to change', async () => {
    const { db, filed } = attributed({ observing: true, total: 12, mutating: 0 });
    await db.dbSnapshot({ tables: ['orders'] });
    await assert.rejects(db.expectDbDelta({ table: 'orders', delta: 1, timeoutMs: 10 }));
    assert.equal(filed[0]?.category, 'functional');
    assert.equal(filed[0]?.severity, 'medium');
    assert.match(filed[0]?.detail ?? '', /no POST, PUT, PATCH or DELETE/);
    assert.match(filed[0]?.detail ?? '', /keeps its state in the browser/);
  });

  it('says nothing about attribution when nothing was watching', async () => {
    // No observer is an environment fact, not a page fact — claiming "the page
    // sent no write" on the strength of not having looked would be the
    // overstatement every other attribution in this codebase refuses.
    const { db, filed } = attributed({ observing: false, total: 0, mutating: 0 });
    await db.dbSnapshot({ tables: ['orders'] });
    await assert.rejects(db.expectDbDelta({ table: 'orders', delta: 1, timeoutMs: 10 }));
    assert.equal(filed[0]?.category, 'backend');
    assert.doesNotMatch(filed[0]?.detail ?? '', /no POST/);
  });
});
