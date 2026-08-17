/**
 * wowUI. Unit tier — a rendered string and a directory of JSON, no browser,
 * no model, no cost.
 *
 * What is worth asserting here is not "the page contains a div". It is the
 * three properties that would be silently lost the next time someone edits
 * this: that the page cannot reach the network, that the run list cannot leak
 * megabytes of screenshots into a poll, and that a crafted run id cannot walk
 * out of the proof directory.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ProofBundle } from '../src/engine/proof-bundle.js';
import { SUPPORTED_EXTENSIONS } from '../src/catalog/extract.js';
import { UiCommandError, buildArgv, commandById } from '../src/ui/commands.js';
import { UploadError, deleteDocument, safeName } from '../src/ui/uploads.js';
import { clearProofCache, readProof, readProofIndex, toCard } from '../src/ui/proofs.js';
import { renderWowUi } from '../src/ui/wow-ui-html.js';
import { applyProgressLine, type JobProgress } from '../src/ui/jobs.js';
import { ModelSelection, ModelSelectionError } from '../src/ui/models.js';

function bundle(overrides: Partial<ProofBundle> = {}): ProofBundle {
  return {
    runId: 'run-1',
    name: 'login',
    status: 'passed',
    startedAt: '2026-08-10T09:00:00.000Z',
    finishedAt: '2026-08-10T09:00:12.000Z',
    durationMs: 12_000,
    cdpUrl: 'http://localhost:9222',
    cachePath: null,
    healerModel: null,
    summary: {
      totalSteps: 2,
      passed: 2,
      failed: 0,
      frontend: { steps: 2, passed: 2, failed: 0, defects: 0 },
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: 2,
      caseRetries: 0,
      cacheHits: 0,
      jitHeals: 0,
      dialogsDismissed: 0,
      agentTakeovers: 0,
      visualChecks: 0,
      visualFailures: 0,
      dataRetries: 0,
      apiRequests: 0,
      apiFailures: 0,
      networkCalls: 0,
      networkFailures: 0,
      backendBlocked: 0,
      healUnavailable: 0,
      networkDropped: 0,
      healLatencyMs: 0,
      agentLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      defects: 0,
    },
    steps: [
      {
        index: 0,
        action: 'goto',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'passed',
        startedAt: '2026-08-10T09:00:00.000Z',
        durationMs: 900,
        url: 'http://localhost:3000/login',
        screenshot: 'AAAA',
      },
      {
        index: 1,
        action: 'click',
        intent: 'the sign-in button works',
        selector: 'role=button[name="Sign in"]',
        resolvedSelector: 'role=button[name="Sign in"]',
        resolution: 'fast',
        status: 'passed',
        startedAt: '2026-08-10T09:00:01.000Z',
        durationMs: 400,
        url: 'http://localhost:3000/login',
        screenshot: 'BBBB',
      },
    ],
    defects: [],
    ...overrides,
  };
}

describe('the wowUI page', () => {
  const html = renderWowUi();

  it('cannot phone home — it is one self-contained document', () => {
    // Same rule as the HTML report and the control panel. A page bound to a
    // port that fetches a script from the internet is a supply chain, not a
    // panel.
    assert.doesNotMatch(html, /<script src=|rel="stylesheet"|fonts\.googleapis|@import/);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|www\.w3\.org)/);
  });

  it('carries both palettes of the shared theme rather than a third dialect', () => {
    assert.match(html, /#F7F7F4/, 'the light canvas');
    assert.match(html, /#06b6d4/, 'the dark accent');
  });

  it('wears GRIM’s QA Command Center classes, so the two can be diffed', () => {
    for (const cls of ['.side', '.nav-item', '.stats', '.rows', '.row', '.rail', '.chip',
      '.verdict', '.tbl', '.cycle', '.drawer', '.modal', '.toast-msg', '.req-card', '.f-pill']) {
      assert.ok(html.includes(cls), `${cls} missing — the layout is not GRIM's any more`);
    }
  });

  it('takes documents, in GRIM’s three-mode launcher', () => {
    for (const field of ['Start verification', 'Add Context', 'Add Catalog', 'Describe',
      'Anything to look at especially', 'Page to prove it against', 'Options for this run only']) {
      assert.ok(html.includes(field), `the modal lost "${field}"`);
    }
  });

  it('never asks anyone to supply a flow', () => {
    // The point of the change: a flow is something wowlidator writes, not a
    // file a person maintains and picks from a list. If a flow selector ever
    // comes back, this is the test that should stop it.
    assert.equal(html.includes('The flow to run'), false);
    assert.equal(html.includes('Start from a flow on disk'), false);
    assert.equal(html.includes('Paste a flow'), false);
    assert.doesNotMatch(html, /commandId: 'run'/);
  });

  it('offers every format the extractor can actually read', () => {
    // A picker that accepts a .docx the extractor refuses is a picker that
    // produces an error after the upload rather than before it.
    for (const extension of SUPPORTED_EXTENSIONS) {
      assert.ok(html.includes(extension), `the file picker does not offer ${extension}`);
    }
  });

  it('shows the claims before anything is proved', () => {
    assert.ok(html.includes('lists what it claims'));
    assert.match(html, /untick anything you do not want before it costs tokens and a browser/);
    // The two halves of the gate, both declared in the whitelist.
    assert.ok(html.includes("'catalog-claims'"));
    assert.ok(html.includes("'catalog-run'"));
  });

  it('shows evidence the way GRIM does: error, trace, fix, kept apart', () => {
    assert.ok(html.includes("'Error'") && html.includes("'Trace'"));
    assert.ok(html.includes('Raw output (the facts)'));
    assert.ok(html.includes('How to prove it again'));
    // The line that keeps a model's proposal from reading as a measurement.
    assert.ok(html.includes('kept apart from the facts'));
  });

  it('offers the actual flow: play the film with step subtitles, or record one on demand', () => {
    assert.ok(html.includes('View actual flow'), 'the player button is missing');
    assert.ok(html.includes('Record actual flow'), 'the record-on-demand button is missing');
    assert.ok(html.includes('openFlowPlayer'));
    assert.ok(html.includes('flow-subtitle'), 'the live subtitle bar is missing');
    // The failing segment carries how it failed, not just that it did.
    assert.match(html, /active\.failed && active\.error/);
  });

  it('keeps a finished run’s command output reachable, collapsed under its card', () => {
    // The live row disappears the moment the proof lands; without this the
    // stream it carried (authoring narration, agent turns, progress lines)
    // was orphaned. Collapsed by default: the evidence is the point, the
    // console is the receipts.
    assert.ok(html.includes('Command output ('), 'the collapsible section header is missing');
    assert.ok(html.includes('jobForRun'), 'runs must be matched to the job that produced them');
    assert.match(html, /outOpen/);
  });

  it('puts a runtime on every step, and a total under them', () => {
    // "It passed" and "it passed in 4.1s against a 2s fast path" are different
    // facts, and only one of them predicts next week.
    assert.ok(html.includes("text: 'Took'"), 'the checks table lost its runtime column');
    assert.ok(html.includes('wall clock '), 'the total is what says whether the steps are the whole story');
  });

  it('shows which key runs start on, and never a key itself', () => {
    assert.ok(html.includes('Models and keys'));
    assert.ok(html.includes('Key in use'));
    assert.ok(html.includes('runs start here'));
    // The page asks the server for masks; nothing in it should be reaching for
    // a raw value, and no env var name should be interpolated into a request.
    assert.doesNotMatch(html, /apiKey|api_key|process\.env/);
  });

  it('lets a role be pointed at another provider and model', () => {
    assert.ok(html.includes('Provider and model'));
    assert.ok(html.includes('/api/models'));
    // Completions, not a fixed list: the ids come from the provider at runtime,
    // and none of them is compiled into this page.
    assert.ok(html.includes('datalist'));
    assert.doesNotMatch(html, /gemini-\d|llama-\d/);
  });

  it('shows a live run as a bar with a time estimate, on both surfaces', () => {
    assert.ok(html.includes('progressBar'));
    assert.ok(html.includes('estimating…'));
    // Progress is deliberately outside the render fingerprint — see
    // dataSignature() — so the bars are written to in place instead.
    assert.ok(html.includes('tickProgress'));
    assert.doesNotMatch(html, /S\.jobs\.map\(function \(j\) \{ return j\.id \+ j\.status \+ j\.progress/);
  });

  it('builds every node through el(), never from an HTML string', () => {
    // `textContent` cannot be talked into executing a selector, a model's
    // reasoning, or application text quoted back by a failing step. Unlike the
    // command panel there is no `trustedHtml` escape hatch here at all.
    assert.doesNotMatch(html, /innerHTML|trustedHtml|insertAdjacentHTML|document\.write/);
  });
});

describe('the command whitelist', () => {
  const claims = commandById('catalog-claims')!;
  const run = commandById('catalog-run')!;

  it('carries a fixed flag the form has no control for', () => {
    // "List the claims" and "prove the approved ones" are two panel actions
    // backed by one CLI command; the flag that tells them apart stays declared
    // here rather than being appended by the server.
    // Positionals first, then flags — the order `parseArgs` on the other side
    // expects, with the fixed flag among the rest.
    assert.deepEqual(buildArgv(claims, { catalog: 'cases.md' }), ['catalog', 'cases.md', '--claims-only']);
    assert.equal(buildArgv(run, { catalog: 'cases.md', claims: 'c.json' }).includes('--claims-only'), false);
  });

  it('repeats a repeatable flag once per value', () => {
    const argv = buildArgv(claims, { catalog: 'cases.md', 'context-doc': ['a.md', 'b.md'] });
    assert.deepEqual(argv.slice(argv.indexOf('--context-doc')), ['--context-doc', 'a.md', '--context-doc', 'b.md']);
  });

  it('refuses a repeatable flag smuggled in as one string', () => {
    // Otherwise "a.md --url http://evil" arrives as a single argv entry that
    // the CLI would happily split — the whole reason submissions become an
    // argv array rather than a string.
    assert.throws(() => buildArgv(claims, { catalog: 'c.md', 'context-doc': 'a.md b.md' }), UiCommandError);
    assert.throws(() => buildArgv(claims, { catalog: 'c.md', 'context-doc': ['a.md', ''] }), UiCommandError);
  });

  it('still requires what the command cannot run without', () => {
    assert.throws(() => buildArgv(run, { claims: 'c.json' }), UiCommandError);
  });
});

describe('documents the panel stores', () => {
  it('rebuilds a name instead of trusting one', () => {
    // The only thing taken from what the browser sent is the extension.
    assert.equal(safeName('../../.ssh/authorized_keys.md'), 'authorized_keys.md');
    assert.equal(safeName('my cases (final).csv'), 'my-cases-final.csv');
    assert.equal(safeName('/etc/passwd'), 'passwd.txt');
    assert.equal(safeName(''), 'document.txt');
  });

  it('keeps only an extension the extractor can actually read', () => {
    assert.equal(safeName('spec.docx'), 'spec.txt', 'an unreadable extension is replaced, not kept');
    assert.equal(safeName('notes', '.md'), 'notes.md');
  });

  it('refuses to delete anything that is not one of its own documents', async () => {
    // Deletion is the one operation here that destroys something, so it gets
    // the narrowest rule in the server rather than the general roots check.
    for (const path of ['/etc/hosts', 'package.json', '../secrets.md']) {
      await assert.rejects(deleteDocument('context', path), UploadError, path);
    }
  });
});

describe('reading proof bundles', () => {
  let dir = '';

  before(async () => {
    clearProofCache();
    dir = await mkdtemp(join(tmpdir(), 'wowui-proofs-'));
    await writeFile(join(dir, 'run-1.json'), JSON.stringify(bundle()), 'utf8');
    await writeFile(
      join(dir, 'run-2.json'),
      JSON.stringify(
        bundle({
          runId: 'run-2',
          status: 'failed',
          finishedAt: '2026-08-10T10:00:00.000Z',
          trend: {
            verdict: 'newly-broken',
            consecutiveFailures: 0,
            flips: 1,
            sampleSize: 3,
            newFailures: ['click:role=button[name="Sign in"]'],
            message: 'this broke on this run',
          },
        }),
      ),
      'utf8',
    );
    // Neither of these is a bundle. Both must be skipped, not crash the read.
    await writeFile(join(dir, 'notes.json'), '{"hello": "world"}', 'utf8');
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(
      join(dir, 'nested', 'deep.json'),
      JSON.stringify(bundle({ runId: 'run-3', finishedAt: '2026-08-10T08:00:00.000Z' })),
      'utf8',
    );
  });

  after(() => clearProofCache());

  it('lists every bundle, newest first, and counts what it skipped', async () => {
    const index = await readProofIndex(dir);
    assert.deepEqual(index.cards.map((c) => c.runId), ['run-2', 'run-1', 'run-3']);
    assert.equal(index.skipped, 2, 'the two non-bundles');
  });

  it('never puts a screenshot in the list', async () => {
    // The page polls this endpoint. A run with evidence on every step is
    // megabytes, and the list shows none of it.
    const index = await readProofIndex(dir);
    assert.doesNotMatch(JSON.stringify(index.cards), /AAAA|BBBB/);
    assert.equal(index.cards.every((card) => card.hasEvidence), true, 'but it still says there is some');
  });

  it('keeps the trend, because "is this new" is the first question asked', async () => {
    const index = await readProofIndex(dir);
    const failed = index.cards.find((card) => card.runId === 'run-2');
    assert.equal(failed?.trend, 'newly-broken');
    assert.match(failed?.trendMessage ?? '', /broke on this run/);
  });

  it('opens one run in full, evidence and all', async () => {
    const proof = await readProof(dir, 'run-1');
    assert.equal(proof?.steps[1]?.screenshot, 'BBBB');
  });

  it('finds a bundle whose file name is not its run id', async () => {
    const proof = await readProof(dir, 'run-3');
    assert.equal(proof?.runId, 'run-3');
  });

  it('refuses to walk out of the proof directory', async () => {
    // The run id reaches this from the browser. `../../etc/passwd.json` must
    // find nothing rather than resolve to something.
    for (const id of ['../../package', '..%2F..%2Fpackage', '/etc/hosts', 'run-1/../run-2']) {
      assert.equal(await readProof(dir, id), null, id);
    }
    // ...and the legitimate id still works, so the guard is not just "no".
    assert.equal((await readProof(dir, 'run-2'))?.runId, 'run-2');
  });

  it('an empty or missing directory is empty, not an error', async () => {
    const index = await readProofIndex(join(dir, 'does-not-exist'));
    assert.deepEqual(index.cards, []);
  });
});

describe('the card projection', () => {
  it('splits a run by which side of the system it exercised', () => {
    const card = toCard(bundle(), '/tmp/run-1.json');
    assert.equal(card.frontend.steps + card.backend.steps, card.totalSteps);
  });

  it('says when a model wrote the flow, and which one', () => {
    const card = toCard(
      bundle({
        generatedBy: {
          model: 'gemini-2.0-flash',
          generatedAt: '2026-08-10T08:00:00.000Z',
          sourceUrl: 'http://localhost:3000/login',
          kind: 'happy-path',
          rationale: 'the page has a form',
        },
      }),
      '/tmp/run-1.json',
    );
    assert.equal(card.generatedBy?.model, 'gemini-2.0-flash');
    assert.equal(card.generatedBy?.sourceUrl, 'http://localhost:3000/login');
  });
});

describe('live progress, read out of the command\'s own output', () => {
  const fresh = (): JobProgress => ({ done: 0, total: null, etaMs: null, percent: null, phase: null });

  it('takes the denominator from the plan line the run announces', () => {
    const progress = fresh();
    assert.equal(applyProgressLine(progress, '  plan       17 step(s)', 0), true);
    assert.equal(progress.total, 17);
  });

  it('counts a finished step from its index, which is zero-based', () => {
    const progress = fresh();
    applyProgressLine(progress, '  plan       4 step(s)', 0);
    applyProgressLine(progress, '\u2713 [0] request (165ms)', 1_000);
    assert.equal(progress.done, 1);
    applyProgressLine(progress, '\u2717 [1] expectStatus (2ms)', 2_000);
    assert.equal(progress.done, 2, 'a failed step still happened');
  });

  it('estimates from the pace of this run, and sharpens as it goes', () => {
    const progress = fresh();
    applyProgressLine(progress, '  plan       10 step(s)', 0);
    applyProgressLine(progress, '\u2713 [0] click (1ms)', 1_000);
    assert.equal(progress.etaMs, 9_000, '1s for 1 of 10 -> 9s left');
    // The run slows down; the estimate follows rather than holding a constant.
    applyProgressLine(progress, '\u2713 [1] click (1ms)', 4_000);
    assert.equal(progress.etaMs, 16_000);
  });

  it('does not estimate before there is anything to extrapolate from', () => {
    const progress = fresh();
    applyProgressLine(progress, '  plan       10 step(s)', 0);
    assert.equal(progress.etaMs, null);
  });

  it('stops estimating once every planned step is accounted for', () => {
    // What is left is the report and the disconnect, which this cannot time.
    const progress = fresh();
    applyProgressLine(progress, '  plan       2 step(s)', 0);
    applyProgressLine(progress, '\u2713 [1] click (1ms)', 5_000);
    assert.equal(progress.etaMs, 0);
  });

  it('does not go backwards when a repair restarts the flow', () => {
    // --repair runs the whole flow again and the indices start at 0 again.
    // Counting lines instead of taking the maximum reports 40 of 20 done.
    const progress = fresh();
    applyProgressLine(progress, '  plan       3 step(s)', 0);
    applyProgressLine(progress, '\u2713 [2] click (1ms)', 3_000);
    assert.equal(applyProgressLine(progress, '\u2713 [0] goto (1ms)', 4_000), false);
    assert.equal(progress.done, 3);
  });

  it('ignores a line that is not progress', () => {
    const progress = fresh();
    assert.equal(applyProgressLine(progress, '  report     /tmp/run.html', 0), false);
    assert.equal(applyProgressLine(progress, 'PASSED login (211ms)', 0), false);
    assert.equal(progress.done, 0);
    assert.equal(progress.total, null);
  });

  it('leaves a crawl without a denominator rather than inventing one', () => {
    // A crawl discovers its destinations as it goes and announces no plan; the
    // bar paces instead of claiming a fraction.
    const progress = fresh();
    applyProgressLine(progress, '\u2713 [0] visitLink (900ms)', 900);
    assert.equal(progress.total, null);
    assert.equal(progress.done, 1);
    assert.equal(progress.etaMs, null);
  });
});

describe('which model each role runs on', () => {
  // Only the fields these tests touch; the real one comes from `loadConfig`.
  const config = {
    roles: {
      healer: { provider: 'groq', modelId: 'llama-3.3-70b-versatile' },
      generator: { provider: 'google', modelId: 'gemini-2.5-flash' },
      agent: { provider: 'openrouter', modelId: 'some/model' },
      data: { provider: 'groq', modelId: 'llama-3.1-8b-instant' },
    },
    apiKeys: { groq: ['gsk_x'], google: [], openrouter: [] },
  } as never;

  it('changes nothing until something is chosen', () => {
    // An untouched panel has to be invisible to the run it starts, or every
    // run inherits a restatement of its own environment.
    assert.deepEqual(new ModelSelection().envOverlay(), {});
  });

  it('overlays the provider and the model together', () => {
    const models = new ModelSelection();
    models.select('healer', 'google', 'gemini-2.5-flash-lite');
    assert.deepEqual(models.envOverlay(), {
      WOWLIDATOR_HEALER_PROVIDER: 'google',
      WOWLIDATOR_HEALER_MODEL: 'gemini-2.5-flash-lite',
    });
  });

  it('accepts an id no catalogue listed', () => {
    // The list is a convenience, not an authority: it goes stale, the provider
    // can be unreachable, and a brand-new id is exactly what someone is here
    // to type. `doctor` is what actually knows whether an id resolves.
    const models = new ModelSelection();
    models.select('agent', 'openrouter', 'some-lab/model-released-this-morning:free');
    assert.equal(
      models.envOverlay()['WOWLIDATOR_AGENT_MODEL'],
      'some-lab/model-released-this-morning:free',
    );
  });

  it('refuses a role or a provider this codebase cannot construct', () => {
    const models = new ModelSelection();
    assert.throws(() => models.select('oracle', 'groq', 'x'), ModelSelectionError);
    assert.throws(() => models.select('healer', 'openai', 'gpt-4'), ModelSelectionError);
  });

  it('refuses something that is not a model id', () => {
    const models = new ModelSelection();
    assert.throws(() => models.select('healer', 'groq', 'llama\n70b'), ModelSelectionError);
    assert.throws(() => models.select('healer', 'groq', ''), ModelSelectionError);
  });

  it('reports what .env said, so a departure from it is visible', () => {
    const models = new ModelSelection();
    models.select('healer', 'google', 'gemini-2.5-flash-lite');
    const roles = models.describeRoles(config);
    const healer = roles.find((role) => role.role === 'healer')!;
    assert.equal(healer.overridden, true);
    assert.equal(healer.provider, 'google');
    assert.equal(healer.configuredProvider, 'groq');
    assert.equal(healer.configuredModelId, 'llama-3.3-70b-versatile');

    const data = roles.find((role) => role.role === 'data')!;
    assert.equal(data.overridden, false);
    assert.equal(data.modelId, 'llama-3.1-8b-instant');
  });

  it('puts a role back on the environment', () => {
    const models = new ModelSelection();
    models.select('healer', 'google', 'gemini-2.5-flash-lite');
    models.reset('healer');
    assert.deepEqual(models.envOverlay(), {});
  });

  it('says why a catalogue is empty rather than looking merely unpopulated', () => {
    // Nothing has been fetched, and google has no key in this config.
    const view = new ModelSelection().describeCatalogue(config);
    const google = view.find((provider) => provider.provider === 'google')!;
    assert.equal(google.keyed, false);
    assert.equal(google.models.length, 0);
    assert.equal(google.fetchedAt, null);
  });
});
