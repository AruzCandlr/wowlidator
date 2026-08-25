/**
 * The commands that look after the engine's own state: doctor, cache,
 * history, and context. Split out of cli.ts verbatim.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CacheManager } from '../../cache/cache-manager.js';
import { connectDb, defaultDbConfig, maskDsn } from '../../db/client.js';
import { LLM_ROLES, describeRouting } from '../../config.js';
import { ContextEngine } from '../../context/context-engine.js';
import { detectDbHint } from '../../context/db-hint.js';
import {
  graphFileFor,
  listRepos,
  mergedContextDocs,
  mergedScanInputs,
  resolveRepo,
  slugFor,
  upsertRepo,
} from '../../context/repo-registry.js';
import { SUPPORTED_EXTENSIONS, formatFor } from '../../catalog/extract.js';
import { summarize as summarizeContext } from '../../context/query.js';
import { RunHistory } from '../../history/run-history.js';
import { probeIsUsable, probeRole } from '../../providers/probe.js';
import type { CliOptions } from '../options.js';

/**
 * Verify each role end to end: key present, provider constructs, model id
 * actually resolves against the live API. Model ids drift far faster than this
 * codebase does, so this is the command that turns "should work" into "does".
 */
export async function cmdDoctor(options: CliOptions): Promise<number> {
  process.stdout.write(`wowlidator routing\n${describeRouting(options.config)}\n\n`);

  let failures = 0;
  for (const role of LLM_ROLES) {
    const entry = options.config.roles[role];
    const label = `${role.padEnd(9)} ${entry.provider}:${entry.modelId}`;

    // The probe is shared with the panel's Machinery page: one real call over
    // the failover path a run would take, classified by cause. Sequential
    // here on purpose — a rotation discovered for one role stays active for
    // every later role sharing the provider, which is what a run gets too.
    const probe = await probeRole(options.factory, role);
    if (!probeIsUsable(probe.status)) {
      process.stdout.write(`  ✗ ${label}\n      ${probe.detail}\n`);
      for (const attempt of probe.attempts.slice(0, -1)) {
        process.stdout.write(`      key ${attempt.keyIndex + 1}: ${attempt.detail}\n`);
      }
      failures += 1;
      continue;
    }
    const mark = probe.status === 'empty' ? '!' : '✓';
    const reply = probe.reply === null ? '' : ` (${JSON.stringify(probe.reply)})`;
    const quota =
      probe.quota?.remainingTokens !== null && probe.quota?.remainingTokens !== undefined
        ? `\n      ${probe.quota.remainingTokens.toLocaleString()} tokens left` +
          (probe.quota.limitTokens !== null ? ` of ${probe.quota.limitTokens.toLocaleString()}` : '') +
          (probe.quota.resetTokens !== null ? ` (resets in ${probe.quota.resetTokens})` : '')
        : '';
    process.stdout.write(`  ${mark} ${label}\n      ${probe.detail}${reply}${quota}\n`);
    for (const attempt of probe.attempts) {
      process.stdout.write(`      key ${attempt.keyIndex + 1}: ${attempt.detail}\n`);
    }
  }

  // The database, on the same make-a-real-call philosophy as the roles: a
  // SELECT 1 over the exact connection a run would use, plus the schema read
  // the grounding gate depends on. Printed only when a connection is
  // configured — silence for the unconfigured majority, the no-spec rule.
  const dbConfig = defaultDbConfig();
  if (dbConfig !== null) {
    const started = Date.now();
    try {
      const client = await connectDb(dbConfig);
      try {
        await client.query('SELECT 1', []);
        const schema = await client.introspect();
        process.stdout.write(
          `\n  ✓ db        ${maskDsn(dbConfig.url ?? '')}\n` +
            `      read-only session up in ${Date.now() - started}ms — ${schema.tables.length} table(s) visible\n`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      process.stdout.write(`\n  ✗ db        ${detail}\n`);
      failures += 1;
    }
  }

  process.stdout.write(
    failures === 0
      ? '\nall roles reachable\n'
      : `\n${failures} role(s) unusable — see above\n`,
  );
  return failures === 0 ? 0 : 1;
}

export async function cmdCache(
  sub: string | undefined,
  key: string | undefined,
  options: CliOptions,
): Promise<number> {
  const cache = new CacheManager(options.cache === undefined ? {} : { filePath: options.cache });
  await cache.load();

  switch (sub) {
    case 'list': {
      const entries = cache.entries();
      if (entries.length === 0) {
        process.stdout.write(`no healed selectors in ${cache.filePath}\n`);
        return 0;
      }
      process.stdout.write(`${entries.length} healed selector(s) in ${cache.filePath}\n\n`);
      for (const entry of entries) {
        process.stdout.write(
          `${entry.key}\n` +
            `  -> ${entry.healed}  [${entry.strategy}, confidence ${entry.confidence.toFixed(2)}, ${entry.hits} hit(s)]\n` +
            `     ${entry.reasoning}\n\n`,
        );
      }
      return 0;
    }

    case 'forget': {
      if (options.all) {
        const removed = cache.size;
        cache.clear();
        await cache.flush();
        process.stdout.write(`cleared ${removed} entr${removed === 1 ? 'y' : 'ies'}\n`);
        return 0;
      }
      if (!key) {
        process.stderr.write('wowlidator cache forget: provide a key or --all\n');
        return 2;
      }
      const deleted = cache.delete(key);
      await cache.flush();
      process.stdout.write(deleted ? `forgot ${key}\n` : `no cache entry for ${key}\n`);
      return deleted ? 0 : 1;
    }

    default:
      process.stderr.write(`wowlidator cache: unknown subcommand ${sub ?? '(none)'}\n`);
      return 2;
  }
}

/**
 * Forget past runs.
 *
 * Two stores, cleared together, because the UI reads one and the trend reads
 * the other and clearing half of either leaves them disagreeing: the proof
 * bundles are the runs themselves — every step, screenshot and heal — and
 * `history.jsonl` is the thin index the trend verdict is computed from. Delete
 * only the index and the runs stay listed; delete only the bundles and the
 * next run is told it is "still broken" by runs nobody can look at any more.
 *
 * Reports are left alone. They are self-contained files someone may have
 * linked or filed somewhere, and this command is about the engine's own state,
 * not about anything already handed to a person.
 */
export async function cmdHistory(sub: string | undefined, options: CliOptions): Promise<number> {
  switch (sub) {
    case 'clear': {
      const proofDir = resolve(options.out);
      let bundles = 0;
      let names: string[] = [];
      try {
        names = await readdir(proofDir);
      } catch {
        // No proof directory is the same outcome as an empty one.
        names = [];
      }
      for (const name of names) {
        // Only what this engine writes there. A path is never taken from
        // input — the name comes from the directory listing itself — and
        // anything that is not a bundle is left exactly where it is.
        if (!name.endsWith('.json')) continue;
        await rm(join(proofDir, name), { force: true });
        bundles += 1;
      }

      // There is one history index and it does not move with `--out`, so
      // clearing a redirected proof directory must not empty it: the runs it
      // indexes are the ones still sitting in the *default* directory, and
      // deleting their trend while keeping the bundles is the half-cleared
      // state this command exists to avoid. Pointing `--out` somewhere else is
      // therefore a narrower operation, and says so rather than doing more
      // than it was asked to.
      const scoped = proofDir !== resolve(options.config.proofDir);
      const forgotten = scoped ? 0 : await new RunHistory(options.historyPath).clear();

      process.stdout.write(
        `cleared ${bundles} proof bundle(s) from ${proofDir}\n` +
          (scoped
            ? `kept the run history index — it belongs to ${resolve(options.config.proofDir)}\n`
            : `cleared ${forgotten} history entr${forgotten === 1 ? 'y' : 'ies'}\n`),
      );
      return 0;
    }

    default:
      process.stderr.write(`wowlidator history: unknown subcommand ${sub ?? '(none)'}\n`);
      return 2;
  }
}

export async function cmdContext(
  sub: string | undefined,
  options: CliOptions,
  arg?: string,
): Promise<number> {
  const engine = new ContextEngine({
    rootDir: options.root,
    cacheFile: options.contextOut,
    openApiSpec: options.openapi,
    dbSchema: options.dbSchema,
    // Introspection fallback: when no schema file exists but a connection is
    // configured, the live database is the source of truth.
    dbUrl: process.env['WOWLIDATOR_DB_URL'],
    dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
  });

  switch (sub) {
    // Scan a repository and REMEMBER it — the difference from `build`, whose
    // single cache file is last-writer-wins. Saved repos are selected on a run
    // with `--repo <slug|path>` (or the wowUI dropdown).
    case 'add': {
      if (!arg) {
        process.stderr.write('wowlidator context add: missing <path> to the repository\n');
        return 2;
      }
      const slug = slugFor(arg);
      // A re-add without flags falls back to what the entry remembered —
      // wowUI's Re-scan posts only the path, and building bare would drop
      // every operation/table node. See `mergedScanInputs`: the one merged
      // pair feeds both the build and the entry, so they cannot drift.
      // Made absolute HERE, at the command boundary, before the engine or the
      // registry sees them. The schema ingester resolves a relative source
      // against the repository being indexed — right for a file inside it,
      // and wrong for the way people actually type this: from their own
      // directory, naming a schema file that lives elsewhere. Seen live: a
      // repo saved with `--db-schema examples/hrms/x.sql` re-indexed with zero
      // tables and a warning nobody read, and every catalog against it
      // authored without DB checks. A URL (`--openapi https://…`) is left as
      // typed.
      const prior = await resolveRepo(arg);
      // Context documents remembered with the repo — markdown, text, PDF,
      // PowerPoint, Excel or CSV, validated here where a refusal can name the
      // file. Paths are stored absolute and read fresh at authoring time, so
      // an edited file updates the remembered context by itself; re-adding a
      // file of the same name replaces the remembered path.
      const rememberedDocs: string[] = [];
      for (const doc of options.contextDocs) {
        const absolute = resolve(doc);
        if (formatFor(absolute) === undefined) {
          process.stderr.write(
            `wowlidator context add: cannot remember "${doc}" — it reads ${SUPPORTED_EXTENSIONS.join(' ')}\n`,
          );
          return 2;
        }
        try {
          await stat(absolute);
        } catch {
          process.stderr.write(`wowlidator context add: no such context document: ${doc}\n`);
          return 2;
        }
        rememberedDocs.push(absolute);
      }
      const contextDocs = mergedContextDocs(prior, rememberedDocs);
      const { openapi, dbSchema } = mergedScanInputs(prior, {
        openapi: options.openapi === undefined || /^[a-z]+:\/\//i.test(options.openapi) ? options.openapi : resolve(options.openapi),
        dbSchema: options.dbSchema === undefined ? undefined : resolve(options.dbSchema),
      });
      const repoEngine = new ContextEngine({
        rootDir: arg,
        cacheFile: graphFileFor(slug),
        openApiSpec: openapi,
        dbSchema,
        dbUrl: process.env['WOWLIDATOR_DB_URL'],
        dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
      });
      const graph = await repoEngine.build({ force: options.force });
      // What the repo's own files say about its database — a hint for the
      // panel and for anyone asking "what do I set WOWLIDATOR_DB_URL to?".
      // Best-effort file parsing; never a connection, never a password.
      const dbHint = (await detectDbHint(resolve(arg))) ?? prior?.dbHint;
      if (dbHint !== undefined) {
        process.stdout.write(
          `  db hint    ${dbHint.engine} at ${dbHint.host ?? '?'}:${dbHint.port ?? '?'}` +
            `${dbHint.database === undefined ? '' : `/${dbHint.database}`} (from ${dbHint.source})` +
            `${dbHint.passwordAt === undefined ? '' : ` — password: ${dbHint.passwordAt}`}\n`,
        );
      }
      await upsertRepo({
        slug,
        path: resolve(arg),
        indexedAt: new Date().toISOString(),
        nodes: graph.nodes.length,
        openapi,
        dbSchema,
        // A re-scan must not forget what a signed-in capture learned or the
        // documents remembered alongside the code — same rule as
        // `mergedScanInputs` for the scan's own inputs.
        nav: prior?.nav,
        contextDocs,
        dbHint,
      });
      process.stdout.write(
        `${summarizeContext(graph)}\n\nsaved as ${slug} — ground a run in it with --repo ${slug}\n` +
          (contextDocs === undefined
            ? ''
            : `  remembers  ${contextDocs.length} context document(s): ${contextDocs.map((d) => d.split('/').pop()).join(', ')}\n`),
      );
      return 0;
    }

    case 'list': {
      const repos = await listRepos();
      if (repos.length === 0) {
        process.stdout.write('no repositories saved — wowlidator context add <path>\n');
        return 0;
      }
      for (const repo of repos) {
        process.stdout.write(
          `${repo.slug}\n  ${repo.path}\n  ${repo.nodes} node(s), scanned ${repo.indexedAt}\n`,
        );
      }
      return 0;
    }

    case 'build': {
      const graph = await engine.build({ force: options.force });
      process.stdout.write(`${summarizeContext(graph)}\n\nwritten to ${engine.cacheFile}\n`);
      return 0;
    }

    case 'show': {
      const graph = (await engine.load()) ?? (await engine.build());
      process.stdout.write(options.json ? `${JSON.stringify(graph, null, 2)}\n` : `${summarizeContext(graph)}\n`);
      return 0;
    }

    default:
      process.stderr.write(`wowlidator context: unknown subcommand ${sub ?? '(none)'} (expected build, show, add or list)\n`);
      return 2;
  }
}
