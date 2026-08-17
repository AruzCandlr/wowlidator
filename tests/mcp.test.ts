/**
 * The MCP control surface (spec T2).
 *
 * Two of wowlidator's documented invariants live only here and, until now, only in
 * prose:
 *
 * - **MCP owns stdout.** One stray `console.log` anywhere in the engine
 *   corrupts the JSON-RPC stream, and the symptom is a client that mysteriously
 *   disconnects rather than an error anyone can trace. The test drives the
 *   server as a real subprocess over stdio for exactly that reason: an
 *   in-process harness cannot observe the file descriptor being polluted.
 * - **`run_flow` strips screenshots.** Megabytes of base64 in a tool result is
 *   a model-context disaster; `hasScreenshot` carries the fact instead.
 *
 * The schema tests run always; anything that needs a page gates on CDP.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
const ROOT = resolve(import.meta.dirname, '..');
const SERVER = join(ROOT, 'src', 'mcp', 'server.ts');
const TSX_LOADER = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

interface RpcResponse {
  id: number;
  result?: { content?: { type: string; text: string }[]; isError?: boolean };
  error?: { message: string };
}

/**
 * A minimal JSON-RPC client over the server's stdio.
 *
 * Hand-rolled rather than using the SDK client because the point is to watch
 * the raw bytes: the SDK would parse away exactly the contamination this file
 * exists to detect.
 */
class StdioClient {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, (response: RpcResponse) => void>();
  /** Every line stdout produced, parseable or not. */
  readonly lines: string[] = [];
  readonly stderr: string[] = [];

  constructor(env: Record<string, string> = {}) {
    this.#child = spawn(process.execPath, ['--import', TSX_LOADER, SERVER], {
      cwd: ROOT,
      env: { ...process.env, WOWLIDATOR_CDP_URL: CDP_URL, ...env } as NodeJS.ProcessEnv,
    }) as ChildProcessWithoutNullStreams;

    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString();
      let index = this.#buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line) this.#handle(line);
        index = this.#buffer.indexOf('\n');
      }
    });
    this.#child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString()));
  }

  #handle(line: string): void {
    this.lines.push(line);
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return; // Kept in `lines` — that is what the stdout-purity test reads.
    }
    const resolvePending = this.#pending.get(parsed.id);
    if (resolvePending) {
      this.#pending.delete(parsed.id);
      resolvePending(parsed);
    }
  }

  send(method: string, params: unknown, timeoutMs = 60_000): Promise<RpcResponse> {
    const id = this.#nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.#child.stdin.write(`${message}\n`);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}: ${this.stderr.join('')}`)),
        timeoutMs,
      );
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        resolvePromise(response);
      });
    });
  }

  async initialize(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wowlidator-test', version: '0' },
    });
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  }

  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const response = await this.send('tools/call', { name, arguments: args });
    if (response.error) return { text: response.error.message, isError: true };
    const text = response.result?.content?.map((part) => part.text).join('') ?? '';
    return { text, isError: response.result?.isError === true };
  }

  close(): void {
    this.#child.kill();
  }
}

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>mcp fixture</title></head>
<body><button id="go">Go</button><p id="out">idle</p>
<script>document.getElementById('go').addEventListener('click',()=>{document.getElementById('out').textContent='done'});</script>
</body></html>`;

describe('mcp — protocol surface', () => {
  let client: StdioClient;

  before(async () => {
    client = new StdioClient();
    await client.initialize();
  });

  after(() => client.close());

  it('advertises the flow tools', async () => {
    const response = await client.send('tools/list', {});
    const names = JSON.stringify(response.result);
    for (const tool of ['run_flow', 'repair_flow']) {
      assert.ok(names.includes(tool), `${tool} should be advertised`);
    }
  });

  it('rejects a malformed step by naming the field, not by crashing', async () => {
    // The papercut from live use: `expectStatus` takes `status`, and passing
    // `value` used to surface three steps later as "expected is not iterable".
    const { text, isError } = await client.callTool('run_flow', {
      name: 'bad step',
      steps: [{ action: 'expectStatus', value: 200 }],
    });
    assert.ok(isError || /status/i.test(text), `expected a field-level complaint, got: ${text}`);
  });

  it('keeps stdout free of anything that is not JSON-RPC', async () => {
    await client.send('tools/list', {});
    for (const line of client.lines) {
      assert.doesNotThrow(
        () => JSON.parse(line) as unknown,
        `non-JSON on stdout would corrupt the protocol stream: ${line.slice(0, 120)}`,
      );
    }
  });
});

describe('mcp — run_flow (CDP)', { skip: skipBrowser }, () => {
  let client: StdioClient;
  let server: Server;
  let origin: string;

  before(async () => {
    server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Healing off: one of these flows fails on purpose, and a real model call
    // would make the test slow, non-deterministic, and dependent on a key.
    client = new StdioClient({ WOWLIDATOR_DISABLE_REPORT: '1', WOWLIDATOR_DISABLE_HEALING: '1' });
    await client.initialize();
  });

  after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it('runs a flow and returns a proof bundle', async () => {
    const { text } = await client.callTool('run_flow', {
      name: 'mcp pass',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#go', intent: 'Press the button.' },
        { action: 'expectText', selector: '#out', value: 'done', intent: 'It reports done.' },
      ],
      persist: false,
    });

    const bundle = JSON.parse(text) as {
      status: string;
      steps: { hasScreenshot?: boolean; screenshot?: string }[];
      summary: { frontend: unknown; backend: unknown };
    };
    assert.equal(bundle.status, 'passed');
    assert.ok(bundle.summary.frontend, 'the frontend/backend split reaches MCP clients');
  });

  it('strips screenshots and reports their presence instead', async () => {
    const { text } = await client.callTool('run_flow', {
      name: 'mcp screenshot',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectVisible', selector: '#never', intent: 'Forces a failure screenshot.' },
      ],
      persist: false,
    });

    const bundle = JSON.parse(text) as { steps: Record<string, unknown>[] };
    for (const step of bundle.steps) {
      assert.ok(!('screenshot' in step), 'base64 image data must never reach a tool result');
      assert.equal(typeof step['hasScreenshot'], 'boolean');
    }
  });

  it('runs a composed flow, resolving the fragment against the given directory', async () => {
    // `use` is only useful over MCP if paths resolve somewhere predictable.
    const { text } = await client.callTool('run_flow', {
      name: 'mcp composed',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        {
          action: 'when',
          visible: '#go',
          then: [{ action: 'click', selector: '#go', intent: 'Press it only if it is there.' }],
        },
        { action: 'expectText', selector: '#out', value: 'done', intent: 'It reports done.' },
      ],
      persist: false,
    });

    const bundle = JSON.parse(text) as { status: string; steps: { action: string }[] };
    assert.equal(bundle.status, 'passed', text.slice(0, 400));
    assert.ok(bundle.steps.some((step) => step.action === 'when'));
  });
});
