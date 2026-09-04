/**
 * The database baseline (`src/db/baseline.ts`).
 *
 * Unit-tier against a scripted `DbClient` stub, the `tests/db.test.ts` rule:
 * the SQL is ours, so whether a stub answers it proves the LOGIC — detection,
 * snapshot shape, the diff, the restore PLAN — while whether real Postgres
 * accepts the SQL is the gated `WOWLIDATOR_DB_TESTS=1` tier's question, not
 * run here. Nothing in this file connects to a database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DbClient, DbResult, DbSchema } from '../src/db/client.js';
import type { Flow } from '../src/engine/runner.js';
import {
  baselineProbe,
  childFirst,
  detectBaselineTables,
  diffRows,
  probeSql,
  resolveBaselineMode,
  restoreBaseline,
  restorePlan,
  takeBaseline,
  type Baseline,
  type BaselineTable,
} from '../src/db/baseline.js';
import { REDACTED } from '../src/api/redact.js';

const SCHEMA: DbSchema = {
  source: 'introspection',
  tables: [
    {
      name: 'employee',
      columns: [
        { name: 'id', type: 'integer', nullable: false, pk: true },
        { name: 'name', type: 'text', nullable: false, pk: false },
        { name: 'password_hash', type: 'text', nullable: true, pk: false },
      ],
      pk: ['id'],
      references: [],
    },
    {
      name: 'employee_grade',
      columns: [
        { name: 'employee_id', type: 'integer', nullable: false, pk: true },
        { name: 'grade', type: 'text', nullable: false, pk: false },
      ],
      pk: ['employee_id'],
      references: ['employee_id -> employee.id'],
    },
    {
      name: 'audit_log', // no PK — snapshotted, never restored
      columns: [{ name: 'msg', type: 'text', nullable: true, pk: false }],
      pk: [],
      references: [],
    },
  ],
};

function flow(over: Partial<Flow> & { name: string }): { name: string; flow: Flow } {
  return { name: over.name, flow: { steps: [], ...over } as Flow };
}

/**
 * A stub that owns per-table rows and answers the three statement shapes the
 * module emits: the probe (count + md5), a full `SELECT *`, and the restore's
 * write statements (recorded, and applied to the row store so a re-probe sees
 * the change).
 */
class StubDb implements DbClient {
  readonly id = 'stub';
  readonly statements: { sql: string; params: readonly unknown[] }[] = [];
  constructor(public rows: Record<string, Record<string, unknown>[]> = {}) {}

  private tableOf(sql: string): string {
    return (/(?:FROM|INTO|DELETE FROM)\s+("?[\w]+"?\.)?"?([\w]+)"?/i.exec(sql)?.[2] ?? '').toLowerCase();
  }
  private hash(rows: Record<string, unknown>[]): string {
    return rows.length === 0 ? '' : `h:${JSON.stringify([...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))}`;
  }

  async query(sql: string, params: readonly unknown[]): Promise<DbResult> {
    this.statements.push({ sql, params });
    const table = this.tableOf(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK|SET CONSTRAINTS|SELECT setval)/i.test(sql.trim())) {
      return { rows: [], rowCount: 0, durationMs: 0 };
    }
    if (sql.includes('md5(')) {
      const rows = this.rows[table] ?? [];
      return { rows: [{ n: String(rows.length), h: this.hash(rows) }], rowCount: 1, durationMs: 0 };
    }
    if (/^SELECT \* FROM/i.test(sql.trim())) {
      return { rows: [...(this.rows[table] ?? [])], rowCount: (this.rows[table] ?? []).length, durationMs: 0 };
    }
    if (/^DELETE FROM/i.test(sql.trim())) {
      this.rows[table] = [];
      return { rows: [], rowCount: 0, durationMs: 0 };
    }
    if (/^INSERT INTO/i.test(sql.trim())) {
      const cols = (/\(([^)]*)\)\s+OVERRIDING/i.exec(sql)?.[1] ?? '').split(',').map((c) => c.trim().replace(/"/g, '')).filter((c) => c !== '');
      const target = (this.rows[table] ??= []);
      for (let i = 0; i < params.length; i += cols.length) {
        const row: Record<string, unknown> = {};
        cols.forEach((c, j) => (row[c] = params[i + j]));
        target.push(row);
      }
      return { rows: [], rowCount: 0, durationMs: 0 };
    }
    return { rows: [], rowCount: 0, durationMs: 0 };
  }
  async introspect(): Promise<DbSchema> {
    return SCHEMA;
  }
  async close(): Promise<void> {}
}

describe('detection', () => {
  it('takes a table named by a DB step', () => {
    const f = flow({ name: 'HIR-EC-006 hire', steps: [{ action: 'expectDbRow', table: 'employee', where: 'id = 1', intent: '' } as never] });
    const detected = detectBaselineTables([f], SCHEMA, { followFks: false });
    assert.deepEqual(detected.map((d) => d.table), ['employee']);
    assert.match(detected[0]!.why[0]!, /named by a DB step/);
  });

  it('takes a specific table spoken of in the case text, and ignores a vague one', () => {
    const f = flow({ name: 'GRD-01 grades', steps: [{ action: 'click', selector: 'x', intent: 'set the employee_grade to UC' } as never] });
    const detected = detectBaselineTables([f], SCHEMA, { followFks: false });
    assert.ok(detected.some((d) => d.table === 'employee_grade'));
    // `employee` is 8 letters so it IS prose-worthy; assert the vague-word rule
    // via a fresh schema table that is short.
    const shortSchema: DbSchema = { ...SCHEMA, tables: [{ name: 'role', columns: [{ name: 'id', type: 'int', nullable: false, pk: true }], pk: ['id'], references: [] }] };
    const g = flow({ name: 'X', steps: [{ action: 'click', selector: 'x', intent: 'the user has a role' } as never] });
    assert.equal(detectBaselineTables([g], shortSchema, { followFks: false }).length, 0);
  });

  it('expands one FK hop, both directions', () => {
    const f = flow({ name: 'HIR-EC-006', steps: [{ action: 'expectDbRow', table: 'employee', where: 'id=1', intent: '' } as never] });
    const detected = detectBaselineTables([f], SCHEMA); // followFks default true
    // employee_grade references employee → pulled in as a child.
    assert.ok(detected.some((d) => d.table === 'employee_grade'));
    assert.match(detected.find((d) => d.table === 'employee_grade')!.why.join(' '), /references employee/);
  });

  it('detects from a PLAN ROW with no flow — what lets the snapshot precede authoring', () => {
    // The pipelined path: the sheet's words are all that exists when the
    // baseline must be taken, because waiting for authoring to finish would
    // park the engine with cases already queued (ec10, 2026-09-02).
    const detected = detectBaselineTables(
      [{ name: 'HIR-EC-006', text: 'Key-in a new hire and check the employee_grade recorded for them' }],
      SCHEMA,
      { followFks: false },
    );
    assert.deepEqual(detected.map((d) => d.table), ['employee_grade']);
    assert.match(detected[0]!.why[0]!, /spoken of in HIR-EC-006/);
  });

  it('mixes authored flows and plan rows, and an FK hop still applies to both', () => {
    const authored = flow({ name: 'HIR-EC-001 hire', steps: [{ action: 'expectDbRow', table: 'employee', where: 'id=1', intent: '' } as never] });
    const planned = { name: 'HIR-EC-002', text: 'the audit_log keeps every change' };
    const detected = detectBaselineTables([authored, planned], SCHEMA);
    const tables = detected.map((d) => d.table);
    assert.ok(tables.includes('employee'), 'from the authored flow');
    assert.ok(tables.includes('audit_log'), 'from the plan row');
    assert.ok(tables.includes('employee_grade'), 'one FK hop from employee');
  });

  it('a plan row naming nothing contributes nothing, and never throws for want of a flow', () => {
    assert.deepEqual(detectBaselineTables([{ name: 'X_1', text: 'sign in and look at the page' }], SCHEMA), []);
    assert.deepEqual(detectBaselineTables([{ name: 'X_2' }], SCHEMA), []);
  });

  it('honours an operator override even when the schema does not name it', () => {
    const detected = detectBaselineTables([flow({ name: 'X' })], SCHEMA, { extra: ['audit_log', 'made_up'], followFks: false });
    assert.ok(detected.some((d) => d.table === 'audit_log'));
    assert.ok(detected.some((d) => d.table === 'made_up'));
  });
});

describe('mode resolution', () => {
  const base = { WOWLIDATOR_DB_URL: '', WOWLIDATOR_DB_RESTORE_URL: '', WOWLIDATOR_DB_BASELINE: '' } as NodeJS.ProcessEnv;
  it('auto is off with no URL, snapshot with a read URL, restore with a restore URL too', () => {
    assert.equal(resolveBaselineMode(undefined, { ...base }).mode, 'off');
    assert.equal(resolveBaselineMode(undefined, { ...base, WOWLIDATOR_DB_URL: 'x' }).mode, 'snapshot');
    assert.equal(resolveBaselineMode(undefined, { ...base, WOWLIDATOR_DB_URL: 'x', WOWLIDATOR_DB_RESTORE_URL: 'y' }).mode, 'restore');
  });
  it('an explicit restore without a restore URL degrades to snapshot with a note', () => {
    const r = resolveBaselineMode('restore', { ...base, WOWLIDATOR_DB_URL: 'x' });
    assert.equal(r.mode, 'snapshot');
    assert.match(r.note!, /WOWLIDATOR_DB_RESTORE_URL/);
  });
  it('off is off whatever is configured', () => {
    assert.equal(resolveBaselineMode('off', { ...base, WOWLIDATOR_DB_URL: 'x', WOWLIDATOR_DB_RESTORE_URL: 'y' }).mode, 'off');
  });
});

describe('snapshot', () => {
  it('records rows, a stable hash, the PK and restorability; a no-PK table is marked', async () => {
    const db = new StubDb({ employee: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], audit_log: [{ msg: 'x' }] });
    const base = await takeBaseline(db, [{ table: 'employee', why: ['t'] }, { table: 'audit_log', why: ['t'] }], SCHEMA);
    const emp = base.tables.find((t) => t.table === 'employee')!;
    assert.equal(emp.rowCount, 2);
    assert.equal(emp.restorable, true);
    assert.deepEqual(emp.pk, ['id']);
    assert.ok(emp.hash !== '');
    const audit = base.tables.find((t) => t.table === 'audit_log')!;
    assert.equal(audit.restorable, false);
    assert.match(audit.reason!, /no primary key/);
  });

  it('refuses a table over the row bound — compared, not snapshotted', async () => {
    const db = new StubDb({ employee: Array.from({ length: 5 }, (_, i) => ({ id: i, name: 'x' })) });
    const base = await takeBaseline(db, [{ table: 'employee', why: ['t'] }], SCHEMA, { maxRows: 2 });
    const emp = base.tables[0]!;
    assert.equal(emp.restorable, false);
    assert.match(emp.reason!, /over the 2-row bound/);
    assert.equal(emp.rows.length, 0);
    assert.equal(emp.rowCount, 5); // still known, so the compare works
  });

  it('probeSql is one statement with count and md5', () => {
    assert.match(probeSql('employee'), /count\(\*\)/);
    assert.match(probeSql('a.b'), /"a"\."b"/);
  });
});

describe('the per-step diff', () => {
  const emp: BaselineTable = {
    table: 'employee', why: [], columns: ['id', 'name', 'password_hash'], pk: ['id'], references: [],
    rowCount: 2, hash: 'H0', restorable: true,
    rows: [{ id: 1, name: 'A', password_hash: 'secret1' }, { id: 2, name: 'B', password_hash: 'secret2' }],
  };
  it('names inserted, deleted and updated rows keyed on the PK', () => {
    const current = [{ id: 1, name: 'A-renamed', password_hash: 'secret1' }, { id: 3, name: 'C', password_hash: 'secret3' }];
    const change = diffRows(emp, current, { table: 'employee', rowCount: 2, hash: 'H1' });
    assert.equal(change.changed, true);
    assert.equal(change.inserted, 1);
    assert.equal(change.deleted, 1);
    assert.equal(change.updated, 1);
    assert.equal(change.sample!.length, 3);
  });
  it('redacts a password column in the sample', () => {
    const current = [{ id: 1, name: 'A', password_hash: 'secret1' }, { id: 2, name: 'B', password_hash: 'secret2' }, { id: 9, name: 'Z', password_hash: 'leak' }];
    const change = diffRows(emp, current, { table: 'employee', rowCount: 3, hash: 'H1' });
    const inserted = change.sample!.find((s) => s.kind === 'inserted')!;
    assert.equal(inserted.row['password_hash'], REDACTED);
    assert.equal(inserted.row['name'], 'Z');
  });
  it('an unchanged table reports changed:false and no sample', () => {
    const change = diffRows(emp, emp.rows, { table: 'employee', rowCount: 2, hash: 'H0' });
    assert.equal(change.changed, false);
    assert.equal(change.sample, undefined);
  });

  it('the probe seam answers what changed right now', async () => {
    const db = new StubDb({ employee: [{ id: 1, name: 'A' }] });
    const base = await takeBaseline(db, [{ table: 'employee', why: ['t'] }], SCHEMA);
    const probe = baselineProbe(db, base);
    assert.equal((await probe.probe())[0]!.changed, false);
    db.rows['employee']!.push({ id: 2, name: 'B' });
    assert.equal((await probe.probe())[0]!.changed, true);
    assert.deepEqual(probe.summary().tables, ['employee']);
  });
});

describe('the restore plan', () => {
  const baseline: Baseline = {
    version: 1, takenAt: 't', runKey: 'k',
    tables: [
      { table: 'employee', why: [], columns: ['id', 'name'], pk: ['id'], references: [], rowCount: 1, hash: 'H', restorable: true, rows: [{ id: 1, name: 'A' }] },
      { table: 'employee_grade', why: [], columns: ['employee_id', 'grade'], pk: ['employee_id'], references: ['employee_id -> employee.id'], rowCount: 1, hash: 'H', restorable: true, rows: [{ employee_id: 1, grade: 'UC' }] },
      { table: 'audit_log', why: [], columns: ['msg'], pk: [], references: [], rowCount: 1, hash: 'H', restorable: false, rows: [] },
    ],
  };

  it('deletes children before parents and inserts parents before children, with OVERRIDING SYSTEM VALUE', () => {
    const plan = restorePlan(baseline);
    const sqls = plan.map((p) => p.sql);
    assert.equal(sqls[0], 'BEGIN');
    assert.ok(sqls.includes('SET CONSTRAINTS ALL DEFERRED'));
    const delChild = sqls.findIndex((s) => /DELETE FROM "employee_grade"/.test(s));
    const delParent = sqls.findIndex((s) => /DELETE FROM "employee"$/.test(s));
    assert.ok(delChild < delParent, 'child deleted before parent');
    const insParent = sqls.findIndex((s) => /INSERT INTO "employee" /.test(s));
    const insChild = sqls.findIndex((s) => /INSERT INTO "employee_grade" /.test(s));
    assert.ok(insParent < insChild, 'parent inserted before child');
    assert.ok(sqls.some((s) => /OVERRIDING SYSTEM VALUE/.test(s)));
    assert.equal(sqls[sqls.length - 1], 'COMMIT');
    // The allowlist: audit_log is not restorable, so it appears in no statement.
    assert.ok(!sqls.some((s) => /audit_log/.test(s)));
  });

  it('childFirst puts a referencing table before the one it references', () => {
    const order = childFirst(baseline.tables.filter((t) => t.restorable)).map((t) => t.table);
    assert.ok(order.indexOf('employee_grade') < order.indexOf('employee'));
  });
});

describe('restore end to end (stub)', () => {
  it('puts the rows back and verifies each hash against the baseline', async () => {
    const db = new StubDb({ employee: [{ id: 1, name: 'A', password_hash: 'p1' }], employee_grade: [{ employee_id: 1, grade: 'UC' }] });
    const base = await takeBaseline(db, [{ table: 'employee', why: ['t'] }, { table: 'employee_grade', why: ['t'] }], SCHEMA);
    // The run mutates the data.
    db.rows['employee']!.push({ id: 2, name: 'B', password_hash: 'p2' });
    db.rows['employee_grade'] = [];
    const logged: string[] = [];
    const result = await restoreBaseline(db, db, base, { onStatement: (s) => logged.push(s) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.restored.sort(), ['employee', 'employee_grade']);
    assert.equal(result.mismatched.length, 0);
    // Every statement was announced before it ran.
    assert.ok(logged.some((s) => /DELETE FROM/.test(s)));
    assert.ok(logged.some((s) => /INSERT INTO/.test(s)));
    // The data is back to the snapshot.
    assert.equal(db.rows['employee']!.length, 1);
    assert.equal(db.rows['employee_grade']!.length, 1);
  });

  it('a verification mismatch is reported, not thrown, and is not ok', async () => {
    const base: Baseline = {
      version: 1, takenAt: 't', runKey: 'k',
      tables: [{ table: 'employee', why: [], columns: ['id'], pk: ['id'], references: [], rowCount: 1, hash: 'WILL-NOT-MATCH', restorable: true, rows: [{ id: 1 }] }],
    };
    const db = new StubDb({ employee: [] });
    const result = await restoreBaseline(db, db, base, {});
    assert.equal(result.ok, false);
    assert.equal(result.mismatched.length, 1);
    assert.match(result.detail, /still differ/);
  });

  it('rolls back and reports when a statement fails', async () => {
    const base: Baseline = {
      version: 1, takenAt: 't', runKey: 'k',
      tables: [{ table: 'employee', why: [], columns: ['id'], pk: ['id'], references: [], rowCount: 1, hash: 'H', restorable: true, rows: [{ id: 1 }] }],
    };
    let rolledBack = false;
    const boom: DbClient = {
      id: 'boom',
      async query(sql) {
        if (/^ROLLBACK/.test(sql)) rolledBack = true;
        if (/^DELETE/.test(sql)) throw new Error('permission denied');
        return { rows: [], rowCount: 0, durationMs: 0 };
      },
      async introspect() { return SCHEMA; },
      async close() {},
    };
    const result = await restoreBaseline(boom, boom, base, {});
    assert.equal(result.ok, false);
    assert.match(result.detail, /rolled back/);
    assert.equal(rolledBack, true);
  });

  it('nothing restorable yields an honest failure, not an empty success', async () => {
    const base: Baseline = {
      version: 1, takenAt: 't', runKey: 'k',
      tables: [{ table: 'audit_log', why: [], columns: ['msg'], pk: [], references: [], rowCount: 1, hash: 'H', restorable: false, reason: 'no primary key', rows: [] }],
    };
    const db = new StubDb({});
    const result = await restoreBaseline(db, db, base, {});
    assert.equal(result.ok, false);
    assert.match(result.detail, /nothing restorable/);
    assert.deepEqual(result.skipped.map((s) => s.table), ['audit_log']);
  });
});
