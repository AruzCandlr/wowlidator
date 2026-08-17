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
