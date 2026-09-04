/**
 * Getting a usable object back from a model that answers badly.
 *
 * Unit tier throughout — every case here is a provider behaviour reproduced
 * against a mock, which is the point: each one was found against a real
 * provider (z.ai's glm-4.7-flash) and none of them is reproducible on demand,
 * because they are intermittent by nature. A mock is how an intermittent
 * failure becomes a test that fails every time.
 *
 * The three behaviours, all measured on the same model and prompt:
 *
 * - **It omits keys whose value would be empty.** Two thirds of the failures.
 *   `lenientObject` fills them on the way in — see `providers/model-output.ts`.
 * - **It occasionally runs away and truncates.** `generateStructured` re-asks.
 * - **The error said none of this.** The evidence was on a link of the cause
 *   chain nobody read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { MockLanguageModelV4 } from 'ai/test';

import { callsTo, jsonModel, scriptedModel } from './helpers.js';
import { ClaudeAnswerError } from '../src/providers/claude-envelope.js';
import { generateStructured, resetStructuredBreaker } from '../src/providers/llm-factory.js';
import { lenientObject } from '../src/providers/model-output.js';

/** The shape that actually failed: a nested array of flat, all-required steps. */
const Step = lenientObject({
  action: z.enum(['click', 'fill', 'waitFor']),
  selector: z.string(),
  value: z.string(),
  url: z.string(),
});
const Suite = lenientObject({ name: z.string(), steps: z.array(Step) });

describe('a schema that survives a provider dropping keys', () => {
  it('emits every property as required, which strict providers demand', () => {
    // The reason this is a preprocess wrapper and not `.optional()`: Groq's
    // `openai/gpt-oss-*` and OpenAI's own reject a partial `required` before
    // the model is even asked.
    const json = z.toJSONSchema(Step) as { required?: string[]; properties?: object };
    assert.deepEqual(
      [...(json.required ?? [])].sort(),
      ['action', 'selector', 'url', 'value'],
      'a dropped key here fails the call before the model is asked',
    );
    assert.deepEqual(Object.keys(json.properties ?? {}).sort(), ['action', 'selector', 'url', 'value']);
  });

  it('accepts the payload z.ai actually sends, which omits the empty fields', () => {
    // Verbatim shape of a real failure: a `waitFor` step with no `value` and
    // no `url`, which zod rejected as "expected string, received undefined".
    const parsed = Step.parse({ action: 'waitFor', selector: 'role=listbox' });
    assert.deepEqual(parsed, { action: 'waitFor', selector: 'role=listbox', value: '', url: '' });
  });

  it('fills omissions nested inside arrays, where the failure actually happened', () => {
    const parsed = Suite.parse({ name: 'search', steps: [{ action: 'click', selector: '#go' }] });
    assert.deepEqual(parsed, {
      name: 'search',
      steps: [{ action: 'click', selector: '#go', value: '', url: '' }],
    });
  });

  it('still rejects an omission that has no empty reading', () => {
    // There is no empty enum member. Inventing one would turn "the model did
    // not answer" into a step that does the wrong thing quietly, which is the
    // one outcome worse than failing.
    assert.equal(Step.safeParse({ selector: '#go', value: '', url: '' }).success, false);
  });

  it('never overwrites a value the model did send, including an explicit null', () => {
    const Nullable = lenientObject({ case: z.string().nullable(), note: z.string() });
    assert.deepEqual(Nullable.parse({ case: 'checkout', note: 'x' }), {
      case: 'checkout',
      note: 'x',
    });
    // Absent means "declined" for a nullable field — the `case` convention
    // `flow-author.ts` had hand-written before this was shared.
    assert.deepEqual(Nullable.parse({ note: 'x' }), { case: null, note: 'x' });
  });

  it('leaves a schema with nothing fillable exactly as it was', () => {
    const Plain = lenientObject({ n: z.number() });
    assert.equal(Plain.safeParse({}).success, false);
    assert.deepEqual(Plain.parse({ n: 3 }), { n: 3 });
  });
});

describe('re-asking a model that answered badly', () => {
  const request = {
    modelLabel: 'mock:flaky',
    schema: Suite,
    system: 'You write tests.',
    prompt: 'Write one.',
  };
  const good = { name: 'ok', steps: [{ action: 'click', selector: '#a', value: '', url: '' }] };

  it('recovers from a truncated response, which the SDK does not retry', async () => {
    // The SDK's own maxRetries covers transport, not a response that arrived
    // intact and was unusable. Measured at ~1 in 5 on glm-4.7-flash, so a
    // failure is a bad roll rather than a model that cannot comply.
    const model = scriptedModel('flaky', ['{"name":"ok","steps":[{"action":"cli', good]);
    const result = await generateStructured({ ...request, model });
    assert.deepEqual(result.object, good);
    assert.equal(callsTo(model), 2, 'it should have asked exactly twice');
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    const model = scriptedModel('hopeless', ['not json at all']);
    await assert.rejects(
      generateStructured({ ...request, model }),
      (error: Error) => {
        assert.match(error.message, /failed to produce a valid structured response/);
        assert.match(error.message, /3 times running/);
        return true;
      },
    );
    assert.equal(callsTo(model), 3, 'bounded — a model that cannot comply must not loop');
  });

  it('re-asks with the complaint attached, never the identical request', async () => {
    // At temperature 0 the same request gets the same malformed reply, so a
    // bare retry can only fail identically — measured three times running on
    // a local model. The second ask must differ, and what differs is the
    // complaint: what was wrong with the first reply.
    const model = scriptedModel('stubborn', ['{"name":"ok","steps":[{"action":"click","selector":"a"', good]);
    await generateStructured({ ...request, model });
    const calls = (model as unknown as { doGenerateCalls: { prompt: unknown }[] }).doGenerateCalls;
    const second = JSON.stringify(calls[1]?.prompt);
    assert.match(second, /PREVIOUS REPLY/);
    assert.match(second, /not valid JSON/);
    assert.doesNotMatch(JSON.stringify(calls[0]?.prompt), /PREVIOUS REPLY/);
  });

  it('does not re-ask when the first answer was already good', async () => {
    const model = jsonModel('fine', good, { inputTokens: 1, outputTokens: 1 });
    await generateStructured({ ...request, model });
    assert.equal(callsTo(model), 1, 're-asking a good answer is pure cost');
  });
});

describe('what the failure message says', () => {
  it('names the fields the model got wrong', async () => {
    // The whole reason this needed reproducing by hand: "response did not
    // match schema" and nothing else. The evidence sits on
    // NoObjectGeneratedError, whose own cause is a TypeValidationError that
    // carries none of it — so unwrapping `cause` once found nothing.
    const model = scriptedModel('wrong-shape', [{ name: 'ok', steps: [{ selector: '#a' }] }]);
    await assert.rejects(
      generateStructured({
        modelLabel: 'mock:wrong',
        schema: Suite,
        system: 's',
        prompt: 'p',
        model,
      }),
      (error: Error) => {
        assert.match(error.message, /rejected/);
        assert.match(error.message, /steps\.action/, 'the offending field is not named');
        return true;
      },
    );
  });

  it('blames the model, not the key, when the model is what failed', async () => {
    const model = scriptedModel('prose', ['sorry, no JSON']);
    await assert.rejects(
      generateStructured({ modelLabel: 'mock:prose', schema: Suite, system: 's', prompt: 'p', model }),
      (error: Error) => {
        assert.match(error.message, /Try a different model id/);
        assert.doesNotMatch(error.message, /rate limit, quota/);
        return true;
      },
    );
  });
});

describe('a connection that dropped is not a schema failure', () => {
  it('is worded as transport, without the "3 times running" advice', async () => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const model = new MockLanguageModelV4({
      modelId: 'gone',
      doGenerate: async () => {
        throw new Error('Cannot connect to API: other side closed');
      },
    });
    await assert.rejects(
      generateStructured({ modelLabel: 'local:default_model', schema: z.object({ a: z.string() }), system: 's', prompt: 'p', model: model as never }),
      (error: Error) => {
        assert.match(error.message, /could not be reached/);
        assert.doesNotMatch(error.message, /3 times running|valid structured response/);
        return true;
      },
    );
  });
});

/**
 * An answer CUT at a provider's own output cap (2026-09-04, claude-cli on a
 * multirole Thai catalog: 17k–24.5k-token authoring answers against the CLI's
 * 32,000 cap). The provider throws a typed error carrying `finishReason:
 * 'length'`; `generateStructured` must put `finish=length` on line one, must
 * NOT re-ask the identical request (temperature 0 — the same cut), and must
 * NOT count it against the breaker (a budget is not a model that cannot do
 * JSON).
 */
describe('an answer cut at the provider\'s own output cap', () => {
  const request = {
    modelLabel: 'mock:capped',
    schema: Suite,
    system: 'You write tests.',
    prompt: 'Write one.',
    task: 'generator',
  };

  function cappedModel(): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'capped',
      doGenerate: async () => {
        throw new ClaudeAnswerError(
          "claude CLI answer was CUT OFF at the CLI's own output cap of 32000 tokens (finish=length; nothing of the object arrived) — this is the model's ceiling; the answer must be smaller",
          { finishReason: 'length', outputCap: 32000, modelCeiling: 32000 },
        );
      },
    });
  }

  it('names the cut on line one, asks once, and gives budget advice — not "try another model"', async () => {
    resetStructuredBreaker();
    const model = cappedModel();
    await assert.rejects(generateStructured({ ...request, model }), (error: Error) => {
      const first = error.message.split('\n')[0] ?? '';
      assert.match(first, /failed to produce a valid structured response/);
      assert.match(first, /CUT OFF/);
      assert.match(first, /finish=length/);
      assert.match(error.message, /cut at an output budget/);
      assert.doesNotMatch(error.message, /Try a different model id/);
      assert.equal(error.name, 'StructuredOutputUnavailableError');
      return true;
    });
    assert.equal(callsTo(model), 1, 'an identical re-ask can only be cut identically');
  });

  it('does not trip the breaker — two cuts in a row still let a good answer through', async () => {
    resetStructuredBreaker();
    await assert.rejects(generateStructured({ ...request, model: cappedModel() }));
    await assert.rejects(generateStructured({ ...request, model: cappedModel() }));
    const good = { name: 'ok', steps: [{ action: 'click', selector: '#a', value: '', url: '' }] };
    const fine = jsonModel('capped', good, { inputTokens: 1, outputTokens: 1 });
    const result = await generateStructured({ ...request, model: fine });
    assert.deepEqual(result.object, good);
    assert.equal(callsTo(fine), 1, 'the circuit for generator@mock:capped must still be closed');
  });
});

describe('the re-ask note carries the parser\'s own complaint', () => {
  it('quotes the SyntaxError position, not only the generic list of causes', async () => {
    resetStructuredBreaker();
    const good = { name: 'ok', steps: [{ action: 'click', selector: '#a', value: '', url: '' }] };
    const model = scriptedModel('sloppy', ['{"name": "ok", "steps": [}', good]);
    await generateStructured({ modelLabel: 'mock:sloppy', schema: Suite, system: 's', prompt: 'p', model });
    const calls = (model as unknown as { doGenerateCalls: { prompt: unknown }[] }).doGenerateCalls;
    const second = JSON.stringify(calls[1]?.prompt);
    assert.match(second, /not valid JSON \(parser: /);
  });
});
