/**
 * The schema ingester: SQL DDL and Prisma parsing, table-node emission, and
 * the coverage link from a flow's DB checks to the tables it verifies.
 *
 * Entirely unit-tier — file-walk-and-parse with no model and no database
 * (introspection fallback is exercised only at the gated PG tier). Fixtures
 * are written in the shape the real tools emit — a pg_dump-flavoured DDL and
 * an ordinary Prisma schema — not in whatever shape this parser prefers.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  SchemaIngester,
  parsePrismaSchema,
  parseSqlSchema,
} from '../src/context/ingesters/schema-ingester.js';
import { ContextEngine } from '../src/context/context-engine.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('SQL DDL parsing', () => {
  it('reads tables, columns, keys and references out of a pg_dump-shaped file', async () => {
    const { tables, warnings } = parseSqlSchema(await readFile(join(FIXTURES, 'schema.sql'), 'utf8'));

    assert.deepEqual(
      tables.map((t) => t.name),
      ['users', 'orders', 'audit_log'],
      'CREATE INDEX is not a table and must not become one',
    );
    assert.equal(warnings.length, 0);

    const users = tables.find((t) => t.name === 'users')!;
    assert.deepEqual(users.pk, ['id']);
    assert.ok(users.columns.includes('id:uuid pk'));
    assert.ok(users.columns.includes('email:text'));

    const orders = tables.find((t) => t.name === 'orders')!;
    // Table-level constraint carries the pk; the fk becomes a reference.
    assert.deepEqual(orders.pk, ['id']);
    assert.ok(orders.references.some((r) => r.startsWith('user_id -> users.')));
    // numeric(10,2) has a comma inside parens; the quoted default has both a
    // paren and the word — neither may split a column.
    assert.ok(orders.columns.some((c) => c.startsWith('total:numeric')));
    assert.ok(orders.columns.some((c) => c.startsWith('status:text')));
  });

  it('warns about what it cannot parse instead of guessing', () => {
    const { tables, warnings } = parseSqlSchema('CREATE TABLE broken (id int'); // unbalanced
    assert.equal(tables.length, 0);
    assert.match(warnings[0] ?? '', /unbalanced/);
  });
});

describe('Prisma schema parsing', () => {
  it('honours @@map and @map, keeps @id, and turns relations into references', async () => {
    const { tables } = parsePrismaSchema(await readFile(join(FIXTURES, 'schema.prisma'), 'utf8'));

    assert.deepEqual(
      tables.map((t) => t.name),
      ['users', 'orders'],
      '@@map decides the table name; generator/datasource blocks are not models',
    );

    const users = tables.find((t) => t.name === 'users')!;
    assert.ok(users.columns.includes('created_at:datetime'), '@map renames the column');
    assert.deepEqual(users.pk, ['id']);
    assert.ok(
      users.references.some((r) => r.includes('-> orders')),
      'a relation field is a reference, not a column',
    );

    const orders = tables.find((t) => t.name === 'orders')!;
    assert.ok(orders.columns.includes('user_id:string'));
    assert.equal(
      orders.columns.some((c) => c.startsWith('user:')),
      false,
      'the relation field itself must not appear as a column',
    );
  });
});

describe('schema-qualified table names', () => {
  // The shape pg_dump emits for a multi-schema database — the first real
  // multi-schema target kept its tables in named schemas, and stripping the
  // qualifier here made the grounding gate refuse tables that exist. The rule
  // mirrors `qualifiedName()` in db/client.ts: bare for the default schema,
  // `schema.table` for everything else.
  const MULTI_SCHEMA_DDL = `
    CREATE TABLE public.users (
        id uuid NOT NULL PRIMARY KEY
    );

    CREATE TABLE benefit_management.benefit_category (
        id uuid NOT NULL PRIMARY KEY
    );

    CREATE TABLE benefit_management.benefit_plan (
        id uuid NOT NULL PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES public.users (id),
        category_id uuid NOT NULL,
        CONSTRAINT plan_category_fk FOREIGN KEY (category_id)
          REFERENCES benefit_management.benefit_category (id)
    );
  `;

  it('keeps a non-public schema on DDL tables and FK targets; public stays bare', () => {
    const { tables, warnings } = parseSqlSchema(MULTI_SCHEMA_DDL);
    assert.equal(warnings.length, 0);
    assert.deepEqual(
      tables.map((t) => t.name),
      ['users', 'benefit_management.benefit_category', 'benefit_management.benefit_plan'],
    );

    const plan = tables.find((t) => t.name === 'benefit_management.benefit_plan')!;
    // A cross-schema FK strips public…
    assert.ok(plan.references.includes('owner_id -> users.id'));
    // …and keeps a named schema, on the table-level constraint spelling too.
    assert.ok(plan.references.includes('category_id -> benefit_management.benefit_category.id'));
  });

  it('emits qualified node ids and reference edges the introspected graph would agree with', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'wowlidator-schema-q-'));
    try {
      await writeFile(join(scratch, 'schema.sql'), MULTI_SCHEMA_DDL);
      const result = await new SchemaIngester().ingest({ rootDir: scratch, files: ['schema.sql'] });

      assert.ok(result.nodes.some((n) => n.id === 'table:benefit_management.benefit_plan'));
      assert.ok(result.nodes.some((n) => n.id === 'table:users'), 'public.users is bare');
      // The edge target is the qualified table, not the schema half of it —
      // a first-dot read would have pointed this at `table:benefit_management`.
      assert.ok(
        result.edges.some(
          (e) =>
            e.from === 'table:benefit_management.benefit_plan' &&
            e.to === 'table:benefit_management.benefit_category' &&
            e.kind === 'references',
        ),
      );
      assert.ok(
        result.edges.some(
          (e) => e.from === 'table:benefit_management.benefit_plan' && e.to === 'table:users',
        ),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('qualifies a Prisma model by @@schema; public and unschema-ed models stay bare', () => {
    const { tables } = parsePrismaSchema(`
model BenefitPlan {
  id      String @id
  owner   User   @relation(fields: [ownerId], references: [id])
  ownerId String @map("owner_id")

  @@map("benefit_plan")
  @@schema("benefit_management")
}

model User {
  id    String        @id
  plans BenefitPlan[]

  @@map("users")
  @@schema("public")
}
`);
    assert.deepEqual(
      tables.map((t) => t.name),
      ['benefit_management.benefit_plan', 'users'],
    );
    // Relation targets go through the same naming, in both directions.
    const plan = tables.find((t) => t.name === 'benefit_management.benefit_plan')!;
    assert.ok(plan.references.includes('owner -> users'));
    const users = tables.find((t) => t.name === 'users')!;
    assert.ok(users.references.includes('plans -> benefit_management.benefit_plan'));
  });
});

describe('the ingester and the graph', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-schema-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits table nodes and reference edges from a discovered schema file', async () => {
    const ddl = await readFile(join(FIXTURES, 'schema.sql'), 'utf8');
    const ingester = new SchemaIngester();
    const result = await ingester.ingest({
      rootDir: FIXTURES,
      files: ['schema.sql'],
    });

    void ddl;
    assert.equal(result.nodes.length, 3);
    const orders = result.nodes.find((n) => n.id === 'table:orders')!;
    assert.equal(orders.kind, 'table');
    assert.equal(orders.meta?.['source'], 'ddl');
    assert.match(orders.meta?.['columns'] ?? '', /status:text/);
    assert.ok(
      result.edges.some(
        (e) => e.from === 'table:orders' && e.to === 'table:users' && e.kind === 'references',
      ),
    );
  });

  it('is a silent no-op when the project has no schema anywhere', async () => {
    const result = await new SchemaIngester().ingest({ rootDir: FIXTURES, files: ['readme.md'] });
    assert.deepEqual(result, { nodes: [], edges: [], warnings: [] });
  });

  it('links a flow’s DB checks to the tables they verify — the coverage answer', async () => {
    await writeFile(join(dir, 'schema.sql'), await readFile(join(FIXTURES, 'schema.sql'), 'utf8'));
    await writeFile(
      join(dir, 'checkout.flow.json'),
      JSON.stringify({
        name: 'checkout persists the order',
        steps: [
          { action: 'request', method: 'POST', url: '/api/orders' },
          { action: 'expectStatus', status: 201 },
          { action: 'expectDbRow', table: 'orders', where: { id: '{{orderId}}' } },
        ],
      }),
    );

    const graph = await new ContextEngine({
      rootDir: dir,
      cacheFile: join(dir, 'graph.json'),
    }).build({ force: true });

    assert.ok(graph.nodes.some((n) => n.id === 'table:orders'));
    const covers = graph.edges.find(
      (e) => e.kind === 'covers' && e.to === 'table:orders',
    );
    assert.ok(covers, 'the graph answers "does anything verify this table?"');
    assert.match(covers.from, /checkout\.flow\.json/);

    // And the endpoint link still works beside it — one linking pass, three layers.
    const orphan = graph.edges.filter((e) => e.kind === 'references');
    assert.ok(orphan.every((e) => e.to.startsWith('table:')), 'reference edges stay table-to-table');
  });
});
