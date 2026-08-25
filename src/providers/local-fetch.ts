/**
 * The transport for the `local` provider — a fetch that waits.
 *
 * A model on this machine answers a 20k-token authoring prompt in one to five
 * minutes: prefill at a few hundred tokens a second, then a few hundred
 * output tokens at ~40/s. Node's global `fetch` (undici) gives up waiting for
 * response HEADERS after 300 s, and a non-streaming completion sends none
 * until the whole generation is done. So the client hung up, the SDK retried
 * at once, the retry queued behind the abandoned generation the server was
 * still finishing for nobody, and timed out too — the cascade the server's
 * own log now names: "client disconnected before the response was sent
 * (client-side timeout? raise it, or use stream=true)". Measured 2026-08-21.
 *
 * This fetch uses its own undici `Agent` with both timeouts raised to
 * `LOCAL_LLM_TIMEOUT_MS` (default 15 minutes; env `LOCAL_LLM_TIMEOUT_MS`),
 * and only the `local` factory entry uses it — a remote provider's 300 s is
 * already far more patience than it deserves. Retries for `local` are set to
 * 0 at the call site for the same reason: a timed-out request is still being
 * generated, and re-sending it is how the server looks hung.
 */
import { Agent, fetch as undiciFetch } from 'undici';

export const DEFAULT_LOCAL_LLM_TIMEOUT_MS = 15 * 60 * 1000;

export function localLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['LOCAL_LLM_TIMEOUT_MS']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_LOCAL_LLM_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LOCAL_LLM_TIMEOUT_MS;
}

let agent: Agent | undefined;
let agentTimeout = -1;

/** One agent per timeout value; the timeout is read on first use so a test can set it. */
export function localDispatcher(timeoutMs = localLlmTimeoutMs()): Agent {
  if (agent === undefined || agentTimeout !== timeoutMs) {
    agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: 10_000 });
    agentTimeout = timeoutMs;
  }
  return agent;
}

/** The shape the AI SDK's `fetch` option wants. */
export const localFetch: typeof globalThis.fetch = ((input: unknown, init?: unknown) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: localDispatcher(),
  })) as unknown as typeof globalThis.fetch;
