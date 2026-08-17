/**
 * The commands that look after the engine's own state: doctor, cache,
 * history, and context. Split out of cli.ts verbatim.
 */

import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { generateText } from 'ai';

import { CacheManager } from '../../cache/cache-manager.js';
import { LLM_ROLES, PROVIDER_META, describeRouting } from '../../config.js';
import { ContextEngine } from '../../context/context-engine.js';
import { summarize as summarizeContext } from '../../context/query.js';
import { RunHistory } from '../../history/run-history.js';
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

    if (!options.factory.canResolve(role)) {
      process.stdout.write(`  ✗ ${label}\n      no API key — ${PROVIDER_META[entry.provider].envKey} is unset\n`);
      failures += 1;
      continue;
    }

    const started = Date.now();
    try {
      // Routed through failover so `doctor` exercises the exact path a real
      // run would take — if key 1 is dead, this both proves key 2 works and
      // leaves it active for every subsequent role sharing the provider.
      const { text, usage } = await options.factory.callWithFailover(role, (resolved) =>
        // Smallest possible round trip that still proves the model id is real.
        generateText({
          model: resolved.model,
          prompt: 'Reply with the single word: ok',
          // Generous on purpose: reasoning models spend output budget on
          // thinking, and a 16-token cap makes a healthy model look empty.
          maxOutputTokens: 512,
          maxRetries: 0,
        }),
      );
      const reply = text.trim();
      const tokens = `${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out`;
      const keyCount = options.config.apiKeys[entry.provider]?.length ?? 1;
      const keyNote =
        keyCount > 1 ? `, key ${options.factory.activeKeyIndex(entry.provider) + 1}/${keyCount}` : '';
      process.stdout.write(
        `  ${reply === '' ? '!' : '✓'} ${label}\n` +
          `      responded in ${Date.now() - started}ms, ${tokens}${keyNote}` +
          `${reply === '' ? ' — EMPTY reply; model may not suit this role' : ` (${JSON.stringify(reply.slice(0, 24))})`}\n`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      process.stdout.write(`  ✗ ${label}\n      ${detail}\n`);
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

export async function cmdContext(sub: string | undefined, options: CliOptions): Promise<number> {
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
      process.stderr.write(`wowlidator context: unknown subcommand ${sub ?? '(none)'} (expected build or show)\n`);
      return 2;
  }
}
