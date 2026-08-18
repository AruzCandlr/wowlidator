/**
 * The wowlidator control panel — a local web UI over the whole CLI.
 *
 * Two surfaces, one server, one command whitelist. `/` is the command-first
 * panel in `app-html.ts`; `/wow` is wowUI (`wow-ui-html.ts`), the same commands
 * and the same artefacts arranged around runs and the evidence behind them,
 * in GRIM's QA Command Center layout. They share every endpoint below, which
 * is the point: a second server would be a second place for the security rules
 * here to be got wrong.
 *
 * Deliberately small and dependency-free: `node:http`, the command whitelist in
 * `commands.ts`, and a page rendered from `app-html.ts`. Adding Express and a
 * bundler to put a form in front of a CLI would be more moving parts than the
 * thing being fronted.
 *
 * What this server is allowed to do is narrow on purpose:
 *
 * - **It runs wowlidator, and only wowlidator.** Every submission is validated against a
 *   spec and turned into an argv array for `spawn` — there is no shell, and no
 *   free-text argument box that would amount to one.
 * - **It reads files only from known roots** (the working directory, the report
 *   and proof directories, the cache file). A report viewer that would serve
 *   any path on the machine is one crafted link away from being an exfiltration
 *   tool, and this binds to a port.
 * - **It binds to 127.0.0.1 and checks the Host header.** A browser on this
 *   machine can reach it; a page on the internet resolving its own hostname to
 *   127.0.0.1 cannot use that to talk to it.
 *
 * Start it with `npm run ui`, or `wowlidator ui`.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LLM_ROLES,
  PROVIDERS,
  PROVIDER_META,
  hasKeyForRole,
  loadConfig,
  loadDotEnv,
  type WowlidatorConfig,
} from '../config.js';
import { DEFAULT_CONTEXT_CACHE_FILE } from '../context/context-engine.js';
import { listRepos } from '../context/repo-registry.js';
import { COMMANDS, UiCommandError, buildArgv, commandById } from './commands.js';
import { JobRunner } from './jobs.js';
import { KeySelection, KeySelectionError } from './keys.js';
import { ModelSelection, ModelSelectionError, persistRoleModel } from './models.js';
import {
  UploadError,
  deleteDocument,
  listDocuments,
  saveDocument,
  type UploadKind,
} from './uploads.js';
import { readProof, readProofIndex } from './proofs.js';
import { renderApp } from './app-html.js';
import { renderWowUi } from './wow-ui-html.js';

export const DEFAULT_UI_PORT = 4600;

interface ServerContext {
  config: WowlidatorConfig;
  jobs: JobRunner;
  /** Directories a file request may resolve inside. */
  roots: string[];
  /** Which of a provider's keys a run started from here should begin on. */
  keys: KeySelection;
  /** Which model each role runs on, when the panel has been asked to change it. */
  models: ModelSelection;
}

/** The directories a file request may resolve inside, for one config. */
function rootsFor(config: WowlidatorConfig): string[] {
  return [
    process.cwd(),
    resolve(config.reportDir),
    resolve(config.proofDir),
    resolve(config.cachePath, '..'),
  ].map((r) => resolve(r));
}

/**
 * Somewhere under one of the allowed roots.
 *
 * `resolve` collapses `..` before the comparison, so a path that climbs out of
 * a root fails the prefix test rather than being normalised into passing it.
 */
function isAllowed(path: string, roots: readonly string[]): boolean {
  const target = resolve(path);
  return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep));
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res: ServerResponse, body: string, status = 200, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limitBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Only this machine, and only under a name that means this machine.
 *
 * The Host check is the part that matters: without it, any page you visit could
 * point its own domain at 127.0.0.1 and drive this server from your browser.
 */
function fromLocalhost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return false;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const hostname = new URL(origin).hostname.toLowerCase();
      if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Every `.flow.json` worth offering, newest first, without walking the world. */
async function findFlows(roots: readonly string[]): Promise<
  { path: string; name: string; steps: number; modified: string; valid: boolean }[]
> {
  const seen = new Set<string>();
  const found: { path: string; name: string; steps: number; modified: string; valid: boolean }[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'build']);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || found.length > 400) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (/\.flow\.json$/i.test(entry.name) && !seen.has(full)) {
        seen.add(full);
        try {
          const [info, raw] = await Promise.all([stat(full), readFile(full, 'utf8')]);
          const parsed = JSON.parse(raw) as { name?: unknown; steps?: unknown; setup?: unknown };
          const valid = typeof parsed.name === 'string' && Array.isArray(parsed.steps);
          found.push({
            path: full,
            name: valid ? (parsed.name as string) : entry.name,
            steps: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
            modified: info.mtime.toISOString(),
            valid,
          });
        } catch {
          // A malformed flow is still worth listing — that is how you find it.
          found.push({ path: full, name: entry.name, steps: 0, modified: '', valid: false });
        }
      }
    }
  }

  for (const root of roots) await walk(root, 0);
  return found.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Rendered reports, newest first. */
async function findReports(dir: string): Promise<{ path: string; name: string; modified: string; size: number }[]> {
  const found: { path: string; name: string; modified: string; size: number }[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 3 || found.length > 500) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (extname(entry.name) === '.html') {
        const info = await stat(full).catch(() => null);
        if (info) {
          found.push({ path: full, name: entry.name, modified: info.mtime.toISOString(), size: info.size });
        }
      }
    }
  }
  await walk(dir, 0);
  return found.sort((a, b) => b.modified.localeCompare(a.modified));
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<void> {
  if (!fromLocalhost(req)) {
    text(res, 'wowlidator ui serves this machine only', 403);
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // ---- the pages ----------------------------------------------------------
  if (path === '/' && req.method === 'GET') {
    text(res, renderApp(), 200, 'text/html; charset=utf-8');
    return;
  }

  // wowUI: the same server, the same commands, GRIM's evidence-first layout.
  if ((path === '/wow' || path === '/wow/') && req.method === 'GET') {
    text(res, renderWowUi(), 200, 'text/html; charset=utf-8');
    return;
  }

  // ---- what this install can do ------------------------------------------
  if (path === '/api/meta' && req.method === 'GET') {
    json(res, {
      commands: COMMANDS,
      cwd: process.cwd(),
      paths: {
        reportDir: resolve(ctx.config.reportDir),
        proofDir: resolve(ctx.config.proofDir),
        cachePath: resolve(ctx.config.cachePath),
        historyPath: resolve(ctx.config.historyPath),
        contextGraph: resolve(DEFAULT_CONTEXT_CACHE_FILE),
      },
      cdpUrl: ctx.config.cdpUrl,
      roles: LLM_ROLES.map((role) => ({
        role,
        provider: ctx.config.roles[role].provider,
        modelId: ctx.config.roles[role].modelId,
        keyed: hasKeyForRole(ctx.config, role),
        envKey: PROVIDER_META[ctx.config.roles[role].provider].envKey,
        consoleUrl: PROVIDER_META[ctx.config.roles[role].provider].consoleUrl,
      })),
    });
    return;
  }

  // ---- jobs ---------------------------------------------------------------
  if (path === '/api/jobs' && req.method === 'GET') {
    json(res, { jobs: ctx.jobs.list().map(summariseJob) });
    return;
  }

  if (path === '/api/jobs' && req.method === 'POST') {
    let body: { commandId?: string; values?: Record<string, unknown> };
    try {
      body = (await readBody(req)) as typeof body;
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
      return;
    }
    const spec = commandById(String(body.commandId ?? ''));
    if (!spec) {
      json(res, { error: `unknown command "${body.commandId}"` }, 400);
      return;
    }
    try {
      const argv = buildArgv(spec, body.values ?? {});
      // The run starts on whichever key the panel is pointed at, with the rest
      // still behind it so in-run failover keeps working.
      const job = ctx.jobs.start(spec, argv, {
        ...ctx.keys.envOverlay(ctx.config),
        ...ctx.models.envOverlay(),
      });
      json(res, { job: summariseJob(job) }, 201);
    } catch (error) {
      const status = error instanceof UiCommandError ? 400 : 409;
      json(res, { error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  const jobMatch = /^\/api\/jobs\/([\w-]+)(\/events|\/stop)?$/.exec(path);
  if (jobMatch) {
    const job = ctx.jobs.get(jobMatch[1]!);
    if (!job) {
      json(res, { error: 'no such job' }, 404);
      return;
    }
    const tail = jobMatch[2];

    if (tail === '/stop' && req.method === 'POST') {
      json(res, { stopped: ctx.jobs.stop(job.id) });
      return;
    }

    if (tail === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // Rejoin from the buffer: a reloaded page should see the run so far, not
      // an empty pane with a spinner.
      send('replay', {
        lines: job.lines,
        artifacts: job.artifacts,
        status: job.status,
        // A page reloaded mid-run rejoins the bar where it is, rather than at
        // zero — the same reason the output buffer is replayed at all.
        progress: job.progress,
      });
      if (job.status !== 'running') {
        send('done', { status: job.status, exitCode: job.exitCode, finishedAt: job.finishedAt });
      }
      const unsubscribe = ctx.jobs.subscribe(job.id, send);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    if (req.method === 'GET') {
      json(res, { job });
      return;
    }
  }

  // ---- artefacts on disk --------------------------------------------------
  if (path === '/api/flows' && req.method === 'GET') {
    json(res, { flows: await findFlows(ctx.roots) });
    return;
  }

  if (path === '/api/reports' && req.method === 'GET') {
    json(res, { reports: await findReports(resolve(ctx.config.reportDir)) });
    return;
  }

  if (path === '/api/history' && req.method === 'GET') {
    const raw = await readFile(resolve(ctx.config.historyPath), 'utf8').catch(() => '');
    const entries = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    json(res, { entries: entries.slice(-300).reverse(), total: entries.length });
    return;
  }

  // ---- which API key runs start on ---------------------------------------
  //
  // Masks and indices only: a key value never reaches the browser, and
  // selecting one is a POST of its index. See `ui/keys.ts`.
  if (path === '/api/keys' && req.method === 'GET') {
    json(res, ctx.keys.describe(ctx.config));
    return;
  }

  if (path === '/api/keys' && req.method === 'POST') {
    let body: { provider?: string; index?: number };
    try {
      body = (await readBody(req)) as typeof body;
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
      return;
    }
    const provider = PROVIDERS.find((name) => name === body.provider);
    if (provider === undefined) {
      json(res, { error: `unknown provider "${String(body.provider)}"` }, 400);
      return;
    }
    try {
      ctx.keys.select(provider, Number(body.index), ctx.config);
      json(res, ctx.keys.describe(ctx.config));
    } catch (error) {
      const status = error instanceof KeySelectionError ? 400 : 500;
      json(res, { error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  // Re-read `.env` without restarting. Keys are the reason this exists: a key
  // added or replaced in the file is otherwise invisible until the panel is
  // restarted, which is exactly when someone is trying to fix a dead one.
  if (path === '/api/keys/reload' && req.method === 'POST') {
    loadDotEnv();
    try {
      ctx.config = loadConfig();
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
      return;
    }
    ctx.roots = rootsFor(ctx.config);
    // A selection pointing past the end of a shortened list would otherwise
    // become a missing-key error inside the next run.
    ctx.keys.prune(ctx.config);
    json(res, ctx.keys.describe(ctx.config));
    return;
  }

  // ---- which model each role runs on -------------------------------------
  //
  // The sibling of the key endpoints above, and the same shape: the browser is
  // told what is available and what is selected, and selecting is a POST of a
  // provider and an id. See `ui/models.ts`.
  if (path === '/api/models' && req.method === 'GET') {
    // Refreshed on read, but cheap: the catalogue is cached for its TTL, so a
    // polling page costs one request per provider every ten minutes.
    await ctx.models.refresh(ctx.config);
    json(res, {
      providers: ctx.models.describeCatalogue(ctx.config),
      roles: ctx.models.describeRoles(ctx.config),
    });
    return;
  }

  if (path === '/api/models/refresh' && req.method === 'POST') {
    await ctx.models.refresh(ctx.config, true);
    json(res, {
      providers: ctx.models.describeCatalogue(ctx.config),
      roles: ctx.models.describeRoles(ctx.config),
    });
    return;
  }

  if (path === '/api/models' && req.method === 'POST') {
    let body: { role?: string; provider?: string; modelId?: string; reset?: boolean };
    try {
      body = (await readBody(req)) as typeof body;
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
      return;
    }
    try {
      if (body.reset === true) {
        ctx.models.reset(String(body.role));
        await persistRoleModel(String(body.role), null);
      } else {
        ctx.models.select(String(body.role), String(body.provider), String(body.modelId));
        await persistRoleModel(String(body.role), {
          provider: String(body.provider),
          modelId: String(body.modelId).trim(),
        });
      }
      // Re-read, so what the page shows next is what the file now says rather
      // than what it said when the panel started. Without this the choice is
      // saved and the UI still reports the old value, which reads exactly like
      // the save having failed.
      loadDotEnv();
      try {
        ctx.config = loadConfig();
      } catch {
        // A file we just wrote should still parse; if it does not, the in-memory
        // choice is still live for this panel's runs and the next reload will
        // surface the real error rather than losing the selection here.
      }
      json(res, {
        providers: ctx.models.describeCatalogue(ctx.config),
        roles: ctx.models.describeRoles(ctx.config),
      });
    } catch (error) {
      const status = error instanceof ModelSelectionError ? 400 : 500;
      json(res, { error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  // ---- catalogs and context documents ------------------------------------
  //
  // The panel writes these itself rather than asking for a path, because the
  // file being tested from usually lives wherever a browser download put it.
  // Names are rebuilt on the way in — see `uploads.ts`.
  if (path === '/api/documents' && req.method === 'GET') {
    const kind = (url.searchParams.get('kind') ?? 'context') as UploadKind;
    json(res, { documents: await listDocuments(kind === 'catalog' ? 'catalog' : 'context') });
    return;
  }

  // Saved repositories — read-only: saving one goes through the ordinary job
  // machinery (`context add` via the whitelist), never a bespoke write here.
  if (path === '/api/repos' && req.method === 'GET') {
    json(res, { repos: await listRepos() });
    return;
  }

  if (path === '/api/documents' && req.method === 'POST') {
    let body: { kind?: string; name?: string; contentBase64?: string; text?: string };
    try {
      // A spreadsheet or a PDF arrives base64'd, so the body limit has to be
      // larger here than the 2MB the command endpoints need.
      body = (await readBody(req, 40_000_000)) as typeof body;
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
      return;
    }
    try {
      const document = await saveDocument({
        kind: (body.kind === 'catalog' ? 'catalog' : 'context') as UploadKind,
        name: String(body.name ?? ''),
        contentBase64: body.contentBase64,
        text: body.text,
      });
      json(res, { document }, 201);
    } catch (error) {
      const status = error instanceof UploadError ? 400 : 500;
      json(res, { error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  if (path === '/api/documents' && req.method === 'DELETE') {
    const kind = (url.searchParams.get('kind') ?? 'context') as UploadKind;
    try {
      await deleteDocument(kind === 'catalog' ? 'catalog' : 'context', url.searchParams.get('path') ?? '');
      json(res, { removed: true });
    } catch (error) {
      const status = error instanceof UploadError ? 400 : 500;
      json(res, { error: error instanceof Error ? error.message : String(error) }, status);
    }
    return;
  }

  // ---- proof bundles, for wowUI ------------------------------------------
  //
  // Two endpoints rather than one, because the difference is megabytes: the
  // list carries no steps and therefore no screenshots, and a run's evidence
  // is fetched only when someone opens it.
  if (path === '/api/proofs' && req.method === 'GET') {
    const index = await readProofIndex(resolve(ctx.config.proofDir));
    json(res, { proofs: index.cards, dir: index.dir, skipped: index.skipped });
    return;
  }

  const proofMatch = /^\/api\/proofs\/(.+)$/.exec(path);
  if (proofMatch && req.method === 'GET') {
    // The run id is looked up inside the proof directory, never joined onto it
    // by this handler — see `readProof`.
    const proof = await readProof(resolve(ctx.config.proofDir), decodeURIComponent(proofMatch[1]!));
    if (proof === null) {
      json(res, { error: 'no proof bundle with that run id' }, 404);
      return;
    }
    json(res, { proof });
    return;
  }

  if (path === '/api/cache' && req.method === 'GET') {
    const raw = await readFile(resolve(ctx.config.cachePath), 'utf8').catch(() => null);
    if (raw === null) {
      json(res, { entries: [], path: resolve(ctx.config.cachePath) });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: Record<string, Record<string, unknown>> };
      const entries = Object.entries(parsed.entries ?? {}).map(([key, value]) => ({ key, ...value }));
      json(res, { entries, path: resolve(ctx.config.cachePath) });
    } catch (error) {
      json(res, { error: `cache file is not readable JSON — ${String(error)}` }, 500);
    }
    return;
  }

  // ---- reading and writing a single file ---------------------------------
  if (path === '/api/file') {
    const target = url.searchParams.get('path') ?? '';
    if (target === '' || !isAllowed(target, ctx.roots)) {
      json(res, { error: 'that path is outside the directories this UI may read' }, 403);
      return;
    }
    if (req.method === 'GET') {
      try {
        json(res, { path: resolve(target), content: await readFile(resolve(target), 'utf8') });
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : String(error) }, 404);
      }
      return;
    }
    if (req.method === 'PUT') {
      let body: { content?: string };
      try {
        body = (await readBody(req)) as typeof body;
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
      if (typeof body.content !== 'string') {
        json(res, { error: 'content must be a string' }, 400);
        return;
      }
      // Saving a flow that is not a flow would fail later, at the point where
      // the message is about a run instead of about the edit that caused it.
      if (/\.json$/i.test(target)) {
        try {
          JSON.parse(body.content);
        } catch (error) {
          json(res, { error: `not valid JSON — ${error instanceof Error ? error.message : String(error)}` }, 400);
          return;
        }
      }
      // wowUI writes a pruned flow into `.wowlidator/flows/`, which will not
      // exist on a fresh checkout. The directory is inside an allowed root by
      // the check above, so creating it grants no reach the write did not
      // already have.
      await mkdir(resolve(target, '..'), { recursive: true });
      await writeFile(resolve(target), body.content, 'utf8');
      json(res, { saved: resolve(target) });
      return;
    }
  }

  // ---- serving a rendered report -----------------------------------------
  if (path === '/view' && req.method === 'GET') {
    const target = url.searchParams.get('path') ?? '';
    if (target === '' || !isAllowed(target, ctx.roots)) {
      text(res, 'that path is outside the directories this UI may read', 403);
      return;
    }
    const info = await stat(resolve(target)).catch(() => null);
    if (!info?.isFile()) {
      text(res, 'no such file', 404);
      return;
    }
    const type = extname(target) === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': info.size });
    createReadStream(resolve(target)).pipe(res);
    return;
  }

  text(res, 'not found', 404);
}

function summariseJob(job: ReturnType<JobRunner['list']>[number]): Record<string, unknown> {
  const { lines, ...rest } = job;
  return { ...rest, lineCount: lines.length };
}

export interface StartUiOptions {
  port?: number;
  host?: string;
  /** Open the page in the desktop browser once the server is up. */
  open?: boolean;
  /** Which of the two surfaces to open: the command panel, or wowUI. */
  openPath?: string;
}

export async function startUi(options: StartUiOptions = {}): Promise<{ url: string; close: () => void }> {
  loadDotEnv();
  const config = loadConfig();
  const jobs = new JobRunner();

  // Every directory a file request may resolve inside. The working directory
  // covers flows and examples; the rest are where wowlidator writes.
  const ctx: ServerContext = {
    config,
    jobs,
    roots: rootsFor(config),
    keys: new KeySelection(),
    models: new ModelSelection(),
  };
  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
      } else {
        res.end();
      }
    });
  });

  const port = options.port ?? Number(process.env['WOWLIDATOR_UI_PORT'] ?? DEFAULT_UI_PORT);
  const host = options.host ?? '127.0.0.1';

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://localhost:${actualPort}/`;

  if (options.open !== false) {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const { spawn } = await import('node:child_process');
    const target = `${url}${(options.openPath ?? '').replace(/^\//, '')}`;
    spawn(opener, [target], { detached: true, stdio: 'ignore', shell: false }).unref();
  }

  return { url, close: () => server.close() };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const portIndex = argv.indexOf('--port');
  const port = portIndex === -1 ? undefined : Number(argv[portIndex + 1]);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    process.stderr.write('wowlidator ui: --port must be a port number\n');
    return 2;
  }

  // One server, two surfaces. `--wow` only decides which one the browser is
  // pointed at; both are served either way, and each links to the other.
  const wow = argv.includes('--wow');

  try {
    const { url } = await startUi({
      ...(port === undefined ? {} : { port }),
      open: !argv.includes('--no-open'),
      openPath: wow ? 'wow' : '',
    });
    process.stdout.write(
      `\n  wowlidator control panel\n\n` +
        `    ${url}                every command, with a manual on the last tab\n` +
        `    ${url}wow             wowUI — runs, verdicts and the evidence behind them\n\n` +
        `  Ctrl-C to stop.\n\n`,
    );
    // Hold the process open; the server is the point of it.
    await new Promise<void>(() => {});
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/EADDRINUSE/.test(message)) {
      process.stderr.write(
        `wowlidator ui: that port is already in use — either the panel is already running, ` +
          `or pass --port <n>.\n`,
      );
      return 3;
    }
    process.stderr.write(`wowlidator ui: ${message}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
