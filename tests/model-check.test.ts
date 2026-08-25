/**
 * Is a role's model ready — the shared probe, and the panel's use of it.
 *
 * Unit tier — no provider, no network, no cost. `probeRole` takes the generate
 * call as a seam and `LlmFactory` takes builders, so every provider answer a
 * real key could produce is scripted here instead of paid for.
 *
 * Two halves, tested apart because they fail differently: `providers/probe.ts`
 * decides *what a failed call means* (out of quota is not a missing model is
 * not a dead provider), and `ui/checks.ts` decides *what gets probed* — the
 * panel's own choices, never the file's — and what the browser is told.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APICallError, type LanguageModel } from 'ai';

import { loadConfig, type WowlidatorConfig } from '../src/config.js';
import { LlmFactory } from '../src/providers/llm-factory.js';
import {
  classifyProbeError,
  probeRole,
  quotaFromHeaders,
  type ProbeGenerate,
} from '../src/providers/probe.js';
import { RoleCheckError, RoleChecks, effectiveConfig } from '../src/ui/checks.js';
import { KeySelection } from '../src/ui/keys.js';
import { ModelSelection } from '../src/ui/models.js';

function configWith(keys: string[], extra: Record<string, string> = {}): WowlidatorConfig {
  return loadConfig({
    GROQ_API_KEY: keys.join(','),
    WOWLIDATOR_HEALER_PROVIDER: 'groq',
    WOWLIDATOR_HEALER_MODEL: 'llama-3.3-70b-versatile',
    WOWLIDATOR_DATA_PROVIDER: 'groq',
    ...extra,
  });
}

/** A factory whose "model" is the key and id it was built from. */
function stubFactory(config: WowlidatorConfig): LlmFactory {
  return new LlmFactory(config, {
    groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel,
    google: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel,
  });
}

function keyOf(model: unknown): string {
  return (model as { apiKey: string }).apiKey;
}

function apiError(statusCode: number, message: string, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
  });
}

/** A generate stub that answers by key: throw for the dead ones, reply for the rest. */
function generateBy(
  script: Record<string, Error | { text: string; headers?: Record<string, string> }>,
): ProbeGenerate {
  return (async (options: { model: unknown }) => {
    const entry = script[keyOf(options.model)];
    if (entry === undefined) throw new Error(`unscripted key`);
    if (entry instanceof Error) throw entry;
    return {
      text: entry.text,
      usage: { inputTokens: 11, outputTokens: 2 },
      response: { headers: entry.headers ?? {} },
    };
  }) as unknown as ProbeGenerate;
}

describe('what a failed probe means', () => {
  it('reads out of quota, and when it refills, off a 429', () => {
    const verdict = classifyProbeError(
      apiError(429, 'Rate limit reached for model llama-3.3-70b-versatile', { 'retry-after': '7' }),
    );
    assert.equal(verdict.status, 'exhausted');
    assert.match(verdict.detail, /out of quota or rate-limited, retry in 7s \(429\)/);
  });

  it('calls a 402 out of credit — OpenRouter’s "no tokens left"', () => {
    assert.equal(classifyProbeError(apiError(402, 'Insufficient credits')).status, 'exhausted');
  });

  it('tells a refused key from a rate-limited one', () => {
    // `isKeyExhaustedError` lumps these together — both mean "rotate". Here
    // they go to different people: one waits, one replaces the key.
    assert.equal(classifyProbeError(apiError(401, 'Invalid API Key')).status, 'rejected');
    assert.equal(classifyProbeError(apiError(403, 'permission denied')).status, 'rejected');
    assert.equal(classifyProbeError(new Error('API key not valid. Please pass a valid API key.')).status, 'rejected');
  });

  it('tells a missing model from a dead key', () => {
    assert.equal(classifyProbeError(apiError(404, 'The model `foo` does not exist')).status, 'model-missing');
    assert.equal(
      classifyProbeError(new Error('models/gemini-9 is not found for API version v1beta')).status,
      'model-missing',
    );
    assert.equal(classifyProbeError(new Error('some-lab/x is not a valid model ID')).status, 'model-missing');
  });

  it('calls a 5xx and a socket error the provider’s problem, not the config’s', () => {
    assert.equal(classifyProbeError(apiError(503, 'Service Unavailable')).status, 'unreachable');
    // z.ai's overload is a 429 with "overloaded" in it — theirs, not the key's.
    const overloaded = classifyProbeError(
      apiError(429, 'The service may be temporarily overloaded, please try again later'),
    );
    assert.equal(overloaded.status, 'unreachable');
    assert.match(overloaded.detail, /overloaded/);
    assert.equal(classifyProbeError(new Error('connect ECONNREFUSED 127.0.0.1:443')).status, 'unreachable');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    assert.equal(classifyProbeError(timeout).status, 'unreachable');
  });

  it('never carries a URL — Google’s key travels in one', () => {
    const verdict = classifyProbeError(
      new Error('Failed to fetch https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSECRET'),
    );
    assert.doesNotMatch(verdict.detail, /AIzaSECRET|googleapis/);
    assert.match(verdict.detail, /<url>/);
  });

  it('reads the rate-limit headroom where a provider states it', () => {
    assert.deepEqual(
      quotaFromHeaders({
        'X-RateLimit-Remaining-Tokens': '5900',
        'x-ratelimit-limit-tokens': '6000',
        'x-ratelimit-reset-tokens': '2m59.56s',
      }),
      {
        remainingTokens: 5900,
        limitTokens: 6000,
        remainingRequests: null,
        limitRequests: null,
        resetTokens: '2m59.56s',
        resetRequests: null,
      },
    );
    // A provider that says nothing yields nothing — never a row of zeros that
    // would read as "nothing left".
    assert.equal(quotaFromHeaders({ 'content-type': 'application/json' }), null);
    assert.equal(quotaFromHeaders(undefined), null);
  });
});

describe('probing a role', () => {
  it('reports ready, with the cost and the headroom', async () => {
    const factory = stubFactory(configWith(['k1']));
    const probe = await probeRole(factory, 'healer', {
      generate: generateBy({ k1: { text: 'ok', headers: { 'x-ratelimit-remaining-tokens': '5900' } } }),
    });
    assert.equal(probe.status, 'ready');
    assert.equal(probe.reply, 'ok');
    assert.equal(probe.keyIndex, 0);
    assert.equal(probe.keyCount, 1);
    assert.deepEqual(probe.usage, { inputTokens: 11, outputTokens: 2 });
    assert.equal(probe.quota?.remainingTokens, 5900);
    assert.match(probe.detail, /responded in \d+ms, 11 in \/ 2 out/);
    assert.deepEqual(probe.attempts, []);
  });

  it('flags an empty reply as usable but suspicious', async () => {
    const factory = stubFactory(configWith(['k1']));
    const probe = await probeRole(factory, 'healer', { generate: generateBy({ k1: { text: '   ' } }) });
    assert.equal(probe.status, 'empty');
    assert.equal(probe.reply, null);
    assert.match(probe.detail, /EMPTY reply/);
  });

  it('walks the failover path and keeps the trail', async () => {
    // Key 1 is out of quota, key 2 answers. The verdict is ready — a run would
    // succeed — and the trail names the dead key, which is what someone needs
    // in order to start the next run past it.
    const factory = stubFactory(configWith(['dead', 'good']));
    const probe = await probeRole(factory, 'healer', {
      generate: generateBy({ dead: apiError(429, 'Rate limit reached'), good: { text: 'ok' } }),
    });
    assert.equal(probe.status, 'ready');
    assert.equal(probe.keyIndex, 1);
    assert.match(probe.detail, /key 2\/2/);
    assert.equal(probe.attempts.length, 1);
    assert.equal(probe.attempts[0]?.keyIndex, 0);
    assert.equal(probe.attempts[0]?.status, 'exhausted');
  });

  it('says every key failed, judged by the last one, when they all did', async () => {
    const factory = stubFactory(configWith(['dead-1', 'dead-2']));
    const probe = await probeRole(factory, 'healer', {
      generate: generateBy({
        'dead-1': apiError(429, 'Rate limit reached'),
        'dead-2': apiError(429, 'Rate limit reached', { 'retry-after': '30' }),
      }),
    });
    assert.equal(probe.status, 'exhausted');
    assert.equal(probe.keyIndex, null);
    assert.match(probe.detail, /all 2 keys failed — last: out of quota or rate-limited, retry in 30s/);
    assert.equal(probe.attempts.length, 2);
  });

  it('does not rotate off a missing model — the second key would fail identically', async () => {
    const factory = stubFactory(configWith(['k1', 'k2']));
    const probe = await probeRole(factory, 'healer', {
      generate: generateBy({ k1: apiError(404, 'model_not_found'), k2: { text: 'ok' } }),
    });
    assert.equal(probe.status, 'model-missing');
    assert.equal(probe.attempts.length, 1, 'one call, not two');
  });

  it('reports no key without making a call', async () => {
    const factory = stubFactory(configWith([]));
    let called = false;
    const probe = await probeRole(factory, 'healer', {
      generate: (async () => { called = true; throw new Error('should not be called'); }) as unknown as ProbeGenerate,
    });
    assert.equal(probe.status, 'no-key');
    assert.equal(called, false);
    assert.match(probe.detail, /GROQ_API_KEY is unset/);
  });

  it('never throws — a dead provider is a status, not an exception', async () => {
    const factory = stubFactory(configWith(['k1']));
    const probe = await probeRole(factory, 'healer', {
      generate: generateBy({ k1: new Error('fetch failed') }),
    });
    assert.equal(probe.status, 'unreachable');
  });
});

describe('the panel’s check', () => {
  it('probes what the next run would get: the panel’s model and the panel’s start key', async () => {
    const config = configWith(['k1', 'k2', 'k3'], { GOOGLE_GENERATIVE_AI_API_KEY: 'g1' });
    const keys = new KeySelection();
    keys.select('groq', 2, config); // runs start on key 3
    const models = new ModelSelection();
    models.select('healer', 'groq', 'llama-3.1-8b-instant'); // and not on what .env says

    const effective = effectiveConfig(config, keys, models);
    assert.equal(effective.config.roles.healer.modelId, 'llama-3.1-8b-instant');
    assert.deepEqual(effective.config.apiKeys.groq, ['k3', 'k1', 'k2']);
    assert.deepEqual(effective.keyOrder['groq'], [2, 0, 1]);
    assert.deepEqual(effective.config.apiKeys.google, ['g1'], 'untouched providers keep their order');

    const seen: { key: string; modelId: string }[] = [];
    const checks = new RoleChecks(
      {
        generate: (async (options: { model: unknown }) => {
          seen.push({ key: keyOf(options.model), modelId: (options.model as { modelId: string }).modelId });
          return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, response: { headers: {} } };
        }) as unknown as ProbeGenerate,
      },
      { groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel },
    );
    const view = await checks.check('healer', config, keys, models);
    assert.deepEqual(seen, [{ key: 'k3', modelId: 'llama-3.1-8b-instant' }]);
    assert.equal(view.status, 'ready');
    // Numbered as the key cards number them, not as the reordered walk did.
    assert.equal(view.keyIndex, 2);
    assert.equal(view.keyMask, '••••');
    assert.match(view.detail, /key 3\/3/);
  });

  it('renumbers the failover trail back to the cards’ numbering', async () => {
    const config = configWith(['k1', 'k2']);
    const keys = new KeySelection();
    keys.select('groq', 1, config); // start on key 2, which is dead; key 1 answers
    const checks = new RoleChecks(
      { generate: generateBy({ k2: apiError(429, 'Rate limit reached'), k1: { text: 'ok' } }) },
      { groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel },
    );
    const view = await checks.check('healer', config, keys, new ModelSelection());
    assert.equal(view.status, 'ready');
    assert.equal(view.keyIndex, 0, 'answered on key 1 as .env lists it');
    assert.equal(view.attempts[0]?.keyIndex, 1, 'key 2 was the dead one');
  });

  it('never moves where runs start', async () => {
    const config = configWith(['dead', 'good']);
    const keys = new KeySelection();
    const checks = new RoleChecks(
      { generate: generateBy({ dead: apiError(429, 'Rate limit reached'), good: { text: 'ok' } }) },
      { groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel },
    );
    await checks.check('healer', config, keys, new ModelSelection());
    assert.equal(keys.activeIndex('groq'), 0, 'the check reports the rotation; the person applies it');
  });

  it('drops a verdict about a model the role no longer points at', async () => {
    const config = configWith(['k1']);
    const models = new ModelSelection();
    const checks = new RoleChecks(
      { generate: generateBy({ k1: { text: 'ok' } }) },
      { groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel },
    );
    await checks.check('healer', config, new KeySelection(), models);
    assert.equal(checks.describe(config, models).length, 1);

    models.select('healer', 'groq', 'some-other-model');
    assert.equal(checks.describe(config, models).length, 0, 'a "ready" about the old model must not survive');
  });

  it('joins a check already running rather than paying twice', async () => {
    const config = configWith(['k1']);
    let calls = 0;
    const checks = new RoleChecks(
      {
        generate: (async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 20));
          return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, response: { headers: {} } };
        }) as unknown as ProbeGenerate,
      },
      { groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel },
    );
    const keys = new KeySelection();
    const models = new ModelSelection();
    const first = checks.check('healer', config, keys, models);
    assert.deepEqual(checks.checking(), ['healer']);
    const second = checks.check('healer', config, keys, models);
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(checks.checking(), []);
  });

  it('refuses a role that does not exist', async () => {
    const checks = new RoleChecks();
    await assert.rejects(
      checks.check('oracle', configWith(['k1']), new KeySelection(), new ModelSelection()),
      RoleCheckError,
    );
  });

  it('never lets a key value reach the browser', async () => {
    const config = configWith(['gsk_live_supersecret_0000a91f']);
    const checks = new RoleChecks(
      { generate: generateBy({ gsk_live_supersecret_0000a91f: apiError(401, 'Invalid API Key gsk_live_supersecret_0000a91f') }) },
      { groq: (apiKey, modelId) => ({ apiKey, modelId }) as unknown as LanguageModel },
    );
    const models = new ModelSelection();
    await checks.check('healer', config, new KeySelection(), models);
    const wire = JSON.stringify(checks.describe(config, models));
    // The provider echoing a key back in its own error text is the one way a
    // credential could get here; the mask is the only form allowed through.
    assert.doesNotMatch(wire, /supersecret/);
    assert.match(wire, /<key 1>/);
  });
});

describe('a provider whose server decides the model', () => {
  it('ignores WOWLIDATOR_<ROLE>_MODEL for local and records the alias instead', () => {
    const config = configWith([], {
      WOWLIDATOR_GENERATOR_PROVIDER: 'local',
      WOWLIDATOR_GENERATOR_MODEL: 'qwen/qwen3.5-9b',
    });
    assert.equal(config.roles.generator.provider, 'local');
    assert.equal(config.roles.generator.modelId, 'default_model', 'mlx_lm\'s alias for the --model it loaded');
  });

  it('offers no model to pick in the panel, and a typed one is not kept', () => {
    const config = configWith([], { WOWLIDATOR_HEALER_PROVIDER: 'local' });
    const models = new ModelSelection();
    models.select('healer', 'local', 'anything-at-all');
    const healer = models.describeRoles(config).find((r) => r.role === 'healer');
    assert.equal(healer?.modelId, 'default_model');
    const local = models.describeCatalogue(config).find((p) => p.provider === 'local');
    assert.equal(local?.fixedModel, true);
    const groq = models.describeCatalogue(config).find((p) => p.provider === 'groq');
    assert.equal(groq?.fixedModel, false);
  });
});

describe('the local transport waits', () => {
  it('reads LOCAL_LLM_TIMEOUT_MS and falls back to fifteen minutes', async () => {
    const { localLlmTimeoutMs, DEFAULT_LOCAL_LLM_TIMEOUT_MS, localDispatcher } = await import('../src/providers/local-fetch.js');
    assert.equal(localLlmTimeoutMs({}), DEFAULT_LOCAL_LLM_TIMEOUT_MS);
    assert.equal(DEFAULT_LOCAL_LLM_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(localLlmTimeoutMs({ LOCAL_LLM_TIMEOUT_MS: '900000' }), 900_000);
    assert.equal(localLlmTimeoutMs({ LOCAL_LLM_TIMEOUT_MS: 'soon' }), DEFAULT_LOCAL_LLM_TIMEOUT_MS);
    // One agent per timeout value, never one per request.
    assert.equal(localDispatcher(1234), localDispatcher(1234));
    await localDispatcher(1234).close();
  });
});
