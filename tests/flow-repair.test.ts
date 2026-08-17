/**
 * Tests for runtime script evolution (`src/repair/`): asking the `generator`
 * role for a targeted fix after a step fails, retrying, and reporting
 * `dead-end` — never throwing — once attempts run out.
 *
 * Two tiers:
 *   - offline: `LlmFlowRepairModel`'s contract (schema narrowing, dropped
 *     steps) via `MockLanguageModelV4`, same seam every other Llm*Model uses.
 *   - CDP: `FlowRepairLoop` driving a real browser via a stub `FlowRepairModel`
 *     — no LLM key needed, same reasoning as `modal.test.ts` not needing one.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  LlmFlowRepairModel,
  type FlowRepairModel,
  type RepairProposal,
  type RepairRequest,
} from '../src/repair/flow-repair-model.js';
import { FlowRepairLoop, applyRepair, buildInvestigationGoal } from '../src/repair/flow-repair-loop.js';
import { runFlow, type Flow, type FlowStep } from '../src/engine/runner.js';
import { jsonModel } from './helpers.js';

describe('LlmFlowRepairModel', () => {
  const baseRequest: RepairRequest = {
    flow: { name: 'f', steps: [{ action: 'click', selector: '#totally-wrong-id', intent: 'the go button' }] },
    failedStep: { action: 'click', selector: '#totally-wrong-id', intent: 'the go button' },
    section: 'steps',
    index: 0,
    error: 'Timed out waiting for selector "#totally-wrong-id"',
    axTree: 'button "Go now"',
    url: 'http://example.test/',
    attempt: 1,
    history: [],
  };

  it('narrows the flat schema into a replacement plus any inserted steps', async () => {
    const payload = {
      canFix: true,
      insertBefore: [
        { action: 'click', selector: '#dismiss', value: '', url: '', intent: 'dismiss the popup' },
      ],
      replacement: {
        action: 'click',
        selector: 'role=button[name="Go now"]',
        value: '',
        url: '',
        intent: 'the go button',
      },
      reasoning: 'The original selector matched nothing; used the accessible name instead.',
    };
    const model = new LlmFlowRepairModel({
      model: jsonModel('mock-repair', payload, { inputTokens: 500, outputTokens: 80 }),
      id: 'mock:repair',
    });

    const proposal = await model.repair(baseRequest);

    assert.equal(proposal.canFix, true);
    assert.equal(proposal.insertBefore.length, 1);
    assert.deepEqual(proposal.replacement, {
      action: 'click',
      // Narrowed through the shared `toFlowStep`, which relaxes name case —
      // see `src/engine/selector.ts`.
      selector: 'role=button[name="Go now" i]',
      intent: 'the go button',
    });
    assert.equal(proposal.reasoning, payload.reasoning);
    assert.equal(proposal.inputTokens, 500);
    assert.equal(proposal.outputTokens, 80);
  });

  it('drops a malformed inserted step rather than propagating garbage', async () => {
    const payload = {
      canFix: true,
      // A click with no selector cannot become a FlowStep — toFlowStep()
      // returns null for it, and the model must filter that out.
      insertBefore: [{ action: 'click', selector: '', value: '', url: '', intent: 'nothing' }],
      replacement: { action: 'click', selector: '#totally-wrong-id', value: '', url: '', intent: '' },
      reasoning: 'no real fix here',
    };
    const model = new LlmFlowRepairModel({
      model: jsonModel('mock-repair', payload, { inputTokens: 10, outputTokens: 10 }),
      id: 'mock:repair',
    });

    const proposal = await model.repair(baseRequest);

    assert.equal(proposal.insertBefore.length, 0);
  });

  it('falls back to the original failed step when the replacement is unusable', async () => {
    const payload = {
      canFix: false,
      insertBefore: [],
      // Malformed: click with empty selector narrows to null.
      replacement: { action: 'click', selector: '', value: '', url: '', intent: '' },
      reasoning: 'the app looks genuinely broken',
    };
    const model = new LlmFlowRepairModel({
      model: jsonModel('mock-repair', payload, { inputTokens: 10, outputTokens: 10 }),
      id: 'mock:repair',
    });

    const proposal = await model.repair(baseRequest);

    assert.equal(proposal.canFix, false);
    assert.deepEqual(proposal.replacement, baseRequest.failedStep);
  });

  it('discards a tail rewrite the request never offered — structurally, not politely', async () => {
    const payload = {
      canFix: true,
      insertBefore: [],
      replacement: {
        action: 'click',
        selector: 'role=button[name="Go now"]',
        value: '',
        url: '',
        intent: '',
      },
      // The model rewrites steps nobody showed it — this must not survive.
      rewriteFollowing: [
        { action: 'click', selector: '#sneaky', value: '', url: '', intent: 'unrequested' },
      ],
      reasoning: 'also rewrote the rest',
    };
    const model = new LlmFlowRepairModel({
      model: jsonModel('mock-repair', payload, { inputTokens: 10, outputTokens: 10 }),
      id: 'mock:repair',
    });

    // No `followingSteps` on the request = no permission to touch the tail.
    const proposal = await model.repair(baseRequest);

    assert.deepEqual(proposal.rewriteFollowing, []);
  });

  it('narrows a tail rewrite when the request offered the following steps', async () => {
    const payload = {
      canFix: true,
      insertBefore: [],
      replacement: {
        action: 'click',
        selector: 'role=button[name="Go now"]',
        value: '',
        url: '',
        intent: '',
      },
      rewriteFollowing: [
        { action: 'expectText', selector: '#status', value: 'went', url: '', intent: 'the result' },
        // Malformed (click with no selector) — dropped, same rule as insertBefore.
        { action: 'click', selector: '', value: '', url: '', intent: '' },
      ],
      reasoning: 'the tail asserted against a page that never exists',
    };
    const model = new LlmFlowRepairModel({
      model: jsonModel('mock-repair', payload, { inputTokens: 10, outputTokens: 10 }),
      id: 'mock:repair',
    });

    const proposal = await model.repair({
      ...baseRequest,
      followingSteps: [{ action: 'expectText', selector: '#old', value: 'stale' }],
    });

    assert.equal(proposal.rewriteFollowing?.length, 1);
    assert.deepEqual(proposal.rewriteFollowing?.[0], {
      action: 'expectText',
      selector: '#status',
      value: 'went',
      intent: 'the result',
    });
  });

  it('resolves its id lazily, without demanding a key at construction', () => {
    // Same fix as LlmDataModel's — the bug this session started from: eager
    // `.id` resolution in the constructor threw for a role the flow never uses.
    assert.doesNotThrow(() => new LlmFlowRepairModel());
  });
});

describe('applyRepair', () => {
  const flow: Flow = {
    name: 'f',
    steps: [
      { action: 'goto', url: '/' },
      { action: 'click', selector: '#broken' },
      { action: 'expectText', selector: '#a', value: 'x' },
      { action: 'expectText', selector: '#b', value: 'y' },
    ],
  };
  const replacement: FlowStep = { action: 'click', selector: '#fixed' };

  it('replaces only the failed step when no tail rewrite is proposed', () => {
    const revised = applyRepair(flow, { section: 'steps', index: 1 }, {
      canFix: true,
      insertBefore: [],
      replacement,
      rewriteFollowing: [],
      reasoning: '',
    });
    assert.deepEqual(revised.steps, [flow.steps[0], replacement, flow.steps[2], flow.steps[3]]);
  });

  it('regenerates from the failed step onward when a tail rewrite is proposed', () => {
    const tail: FlowStep[] = [{ action: 'expectText', selector: '#new', value: 'z' }];
    const inserted: FlowStep = { action: 'waitFor', selector: '#panel' };
    const revised = applyRepair(flow, { section: 'steps', index: 1 }, {
      canFix: true,
      insertBefore: [inserted],
      replacement,
      rewriteFollowing: tail,
      reasoning: '',
    });
    // Steps before the failure are untouched; the failed step and everything
    // after it are gone, replaced by insertBefore + replacement + the rewrite.
    assert.deepEqual(revised.steps, [flow.steps[0], inserted, replacement, ...tail]);
    // The caller's flow is never mutated.
    assert.equal(flow.steps.length, 4);
  });
});

describe('buildInvestigationGoal', () => {
  it('tells the agent to prepare and observe, never to perform the step', () => {
    const goal = buildInvestigationGoal(
      { action: 'click', selector: '#go', intent: 'the go button' },
      'timed out',
    );
    assert.match(goal, /the go button/);
    assert.match(goal, /#go/);
    assert.match(goal, /timed out/);
    assert.match(goal, /Do NOT perform the failed step/);
  });
});

const GO_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>go fixture</title></head>
  <body>
    <button id="real-go" type="button">Go now</button>
    <p id="status">idle</p>
    <script>
      document.getElementById('real-go').addEventListener('click', () => {
        document.getElementById('status').textContent = 'went';
      });
    </script>
  </body>
</html>`;

/** The go button exists but is hidden behind a disclosure — the reinvestigation case. */
const HIDDEN_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>hidden go fixture</title></head>
  <body>
    <button id="reveal" type="button">Open panel</button>
    <div id="panel" style="display:none">
      <button id="real-go" type="button">Go now</button>
    </div>
    <p id="status">idle</p>
    <script>
      document.getElementById('reveal').addEventListener('click', () => {
        document.getElementById('panel').style.display = 'block';
      });
      document.getElementById('real-go').addEventListener('click', () => {
        document.getElementById('status').textContent = 'went';
      });
    </script>
  </body>
</html>`;

/** A scripted stub — no LLM key needed, same reasoning as modal.test.ts. */
function scriptedModel(responses: RepairProposal[]): FlowRepairModel {
  let calls = 0;
  return {
    id: 'stub:repair',
    async repair(_request: RepairRequest): Promise<RepairProposal> {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (!response) throw new Error('scriptedModel: no response configured');
      return response;
    },
  };
}

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('FlowRepairLoop (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url?.startsWith('/hidden') ? HIDDEN_FIXTURE_HTML : GO_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-repair-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  function brokenFlow(): Flow {
    return {
      name: 'broken go button',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#totally-wrong-id', intent: 'the go button' },
        { action: 'expectText', selector: '#status', value: 'went' },
      ],
    };
  }

  it('repairs a bad selector and passes on retry, without touching the caller-supplied flow', async () => {
    const original = brokenFlow();
    const model = scriptedModel([
      {
        canFix: true,
        insertBefore: [],
        replacement: { action: 'click', selector: '#real-go', intent: 'the go button' },
        reasoning: 'The id was wrong; #real-go is the actual button.',
      },
    ]);

    const log: string[] = [];
    const loop = new FlowRepairLoop({
      model,
      outDir: dir,
      onLog: (line) => log.push(line),
      runOptions: { cdpUrl: CDP_URL, cachePath: join(dir, 'repair-pass.cache.json'), fastTimeoutMs: 500 },
    });

    const outcome = await loop.run(original, 'broken');

    // Live narration must show the failure and the fix as they happen, in
    // order — this is the "saw a failure and is regenerating" visibility
    // the loop exists to give, not just the final returned outcome.
    const narration = log.join('\n');
    assert.match(narration, /attempt 1\/3/);
    assert.match(narration, /✗ failed at steps\[1\]/);
    assert.match(narration, /asking the generator role for a fix/);
    assert.match(narration, /got a fix: The id was wrong/);
    assert.match(narration, /attempt 2\/3/);
    assert.match(narration, /✓ passed/);

    assert.equal(outcome.status, 'passed');
    assert.equal(outcome.attempts.length, 2);
    // An unresolvable selector records as 'dead-end', not 'failed' — the
    // loop's own "did this attempt pass" question is status === 'passed'.
    assert.equal(outcome.attempts[0]?.bundle.status, 'dead-end');
    assert.equal(outcome.attempts[1]?.bundle.status, 'passed');

    const repair = outcome.attempts[0]?.repair;
    assert.ok(repair, 'the failing attempt must record what was written for the retry');
    const flowOnDisk = JSON.parse(await readFile(repair!.flowPath, 'utf8')) as Flow;
    assert.equal(flowOnDisk.steps[1]?.action === 'click' && flowOnDisk.steps[1].selector, '#real-go');

    const patch = await readFile(repair!.patchPath, 'utf8');
    assert.match(patch, /real-go/);

    // The original flow object handed in must be untouched — repairs land in
    // new attempt files, never mutate the source.
    assert.equal(original.steps[1]?.action === 'click' && original.steps[1].selector, '#totally-wrong-id');
  });

  it('reinvestigates a failure live: the agent opens the page up, its findings reach the model and the patch', async () => {
    const { WorkflowAgent } = await import('../src/orchestrator/workflow-agent.js');
    // A scripted agent, same reasoning as scriptedModel: clicks the disclosure
    // the target lives behind, then reports done.
    let agentTurn = 0;
    const agent = new WorkflowAgent({
      model: {
        id: 'stub:agent',
        async decide() {
          agentTurn += 1;
          return agentTurn === 1
            ? { action: 'click' as const, selector: '#reveal', value: '', url: '', reasoning: 'open the panel' }
            : { action: 'finish' as const, selector: '', value: '', url: '', reasoning: 'the go button is visible now' };
        },
      },
    });

    const requests: RepairRequest[] = [];
    const model: FlowRepairModel = {
      id: 'stub:repair',
      async repair(request) {
        requests.push(request);
        return {
          canFix: true,
          // Exactly what the investigation demonstrated: reveal, then retry.
          insertBefore: [{ action: 'click', selector: '#reveal', intent: 'open the panel' }],
          replacement: request.failedStep,
          rewriteFollowing: [],
          reasoning: 'the agent showed the button lives behind #reveal',
        };
      },
    };

    const loop = new FlowRepairLoop({
      model,
      agent,
      outDir: dir,
      runOptions: { cdpUrl: CDP_URL, cachePath: join(dir, 'repair-investigate.cache.json'), fastTimeoutMs: 500 },
    });

    const flow: Flow = {
      name: 'hidden go button',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/hidden' },
        { action: 'click', selector: '#real-go', intent: 'the go button' },
        { action: 'expectText', selector: '#status', value: 'went' },
      ],
    };

    const outcome = await loop.run(flow, 'investigated');

    assert.equal(outcome.status, 'passed');
    // The model was handed the agent's findings, and the tree of the page as
    // the agent left it — the revealed button must be in it.
    const request = requests[0]!;
    assert.ok(request.investigation, 'the repair request must carry the investigation');
    assert.equal(request.investigation!.succeeded, true);
    assert.match(request.investigation!.actions.join('\n'), /click #reveal — ok/);
    assert.match(request.axTree, /Go now/);
    // The attempt records the investigation, and the patch narrates it.
    assert.ok(outcome.attempts[0]?.investigation);
    const patch = await readFile(outcome.attempts[0]!.repair!.patchPath, 'utf8');
    assert.match(patch, /Agent reinvestigation \(reached its goal\)/);
    assert.match(patch, /click #reveal — ok/);
  });

  it('regenerates the flow from the failed step onward when allowed to', async () => {
    const requests: RepairRequest[] = [];
    const model: FlowRepairModel = {
      id: 'stub:repair',
      async repair(request) {
        requests.push(request);
        return {
          canFix: true,
          insertBefore: [],
          replacement: { action: 'click', selector: '#real-go', intent: 'the go button' },
          rewriteFollowing: [{ action: 'expectText', selector: '#status', value: 'went' }],
          reasoning: 'the tail asserted against text the page never shows',
        };
      },
    };

    const loop = new FlowRepairLoop({
      model,
      regenerateFrom: true,
      outDir: dir,
      runOptions: { cdpUrl: CDP_URL, cachePath: join(dir, 'repair-regen.cache.json'), fastTimeoutMs: 500 },
    });

    const flow: Flow = {
      name: 'stale tail',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#totally-wrong-id', intent: 'the go button' },
        // Written against a page that does not exist — regenerated, not kept.
        { action: 'expectText', selector: '#status', value: 'this text is nowhere' },
      ],
    };

    const outcome = await loop.run(flow, 'regenerated');

    assert.equal(outcome.status, 'passed');
    // The model was shown the tail it was allowed to rewrite.
    assert.deepEqual(requests[0]?.followingSteps, [
      { action: 'expectText', selector: '#status', value: 'this text is nowhere' },
    ]);
    const flowOnDisk = JSON.parse(
      await readFile(outcome.attempts[0]!.repair!.flowPath, 'utf8'),
    ) as Flow;
    assert.deepEqual(flowOnDisk.steps, [
      { action: 'goto', url: '/' },
      { action: 'click', selector: '#real-go', intent: 'the go button' },
      { action: 'expectText', selector: '#status', value: 'went' },
    ]);
    const patch = await readFile(outcome.attempts[0]!.repair!.patchPath, 'utf8');
    assert.match(patch, /Regenerated from the failed step onward/);
  });

  it('never offers the tail to the model when regeneration is off', async () => {
    const requests: RepairRequest[] = [];
    const model: FlowRepairModel = {
      id: 'stub:repair',
      async repair(request) {
        requests.push(request);
        return {
          canFix: true,
          insertBefore: [],
          replacement: { action: 'click', selector: '#real-go', intent: 'the go button' },
          // Returned anyway — must be discarded, not applied.
          rewriteFollowing: [{ action: 'expectText', selector: '#status', value: 'went' }],
          reasoning: 'fix',
        };
      },
    };

    const loop = new FlowRepairLoop({
      model,
      outDir: dir,
      runOptions: { cdpUrl: CDP_URL, cachePath: join(dir, 'repair-noregen.cache.json'), fastTimeoutMs: 500 },
    });

    const outcome = await loop.run(brokenFlow(), 'unoffered');

    assert.equal(requests[0]?.followingSteps, undefined);
    const flowOnDisk = JSON.parse(
      await readFile(outcome.attempts[0]!.repair!.flowPath, 'utf8'),
    ) as Flow;
    // The original tail survives verbatim — only the failed step moved.
    assert.deepEqual(flowOnDisk.steps[2], { action: 'expectText', selector: '#status', value: 'went' });
    assert.equal(flowOnDisk.steps.length, 3);
  });

  it('reconstructs a failed step in-run: the rescued run passes, the attempt is superseded', async () => {
    const model = scriptedModel([
      {
        canFix: true,
        insertBefore: [],
        replacement: { action: 'click', selector: '#real-go', intent: 'the go button' },
        rewriteFollowing: [],
        reasoning: 'the id was wrong; #real-go is the actual control',
      },
    ]);

    const bundle = await runFlow(
      {
        name: 'in-run rescue',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#totally-wrong-id', intent: 'the go button' },
          { action: 'expectText', selector: '#status', value: 'went' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'inrun-rescue.cache.json'),
        fastTimeoutMs: 400,
        stepRepair: model,
      },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the reconstruction must rescue the run');
    assert.equal(bundle.summary.failed, 0, 'a superseded attempt counts toward nothing');
    const attempt = bundle.steps.find((s) => s.selector === '#totally-wrong-id');
    assert.equal(attempt?.superseded, true);
    const rescued = bundle.steps.find((s) => s.selector === '#real-go');
    assert.equal(rescued?.status, 'passed');
    assert.match(rescued?.reconstruction?.reasoning ?? '', /the id was wrong/);
    assert.equal(rescued?.reconstruction?.attempt, 2);
    const drift = bundle.defects.find((d) => /reconstructed in-run/i.test(d.title));
    assert.equal(drift?.severity, 'medium', 'a rescue is also a finding: the flow is drifting');
    // A rescued run keeps its WHOLE film: the break and the rescue are the
    // footage the drift defect asks someone to look at. Cutting at the
    // superseded failure once produced a passed run whose recording showed
    // two steps of five.
    assert.ok(bundle.video?.data, 'the film of a rescued run must be kept');
    assert.equal(bundle.video?.endsAtStep, undefined, 'and kept whole — nothing was cut');
    assert.equal(typeof rescued?.videoOffsetMs, 'number', 'the rescue itself stays addressable in the film');
  });

  it('an assertion keeps its claim: reconstruction may only prepare, never rewrite it', async () => {
    // The stub tries to weaken the claim to something that already holds
    // ("idle"); the engine must keep the original expectation and accept only
    // the inserted preparation — the same argument that keeps the agent rung
    // off assertions.
    const model = scriptedModel([
      {
        canFix: true,
        insertBefore: [{ action: 'click', selector: '#real-go', intent: 'perform the action first' }],
        replacement: { action: 'expectText', selector: '#status', value: 'idle' },
        rewriteFollowing: [],
        reasoning: 'the status only changes after the button is clicked',
      },
    ]);

    const bundle = await runFlow(
      {
        name: 'assertion keeps claim',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectText', selector: '#status', value: 'went', intent: 'the action took effect' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'inrun-claim.cache.json'),
        fastTimeoutMs: 400,
        stepRepair: model,
      },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'the inserted click makes the ORIGINAL claim true');
    const rescued = bundle.steps.filter((s) => s.action === 'expectText' && !s.superseded);
    assert.equal(rescued.length, 1);
    assert.equal(rescued[0]?.detail?.['expected'], 'went', 'the claim must survive verbatim');
    // The reconstruction record shows the claim was kept, not the stub's rewrite.
    assert.match(rescued[0]?.reconstruction?.to ?? '', /"went"/);
  });

  it('classifies after 3 total tries when reconstructions keep failing', async () => {
    let asks = 0;
    const model: FlowRepairModel = {
      id: 'stub:repair',
      async repair(request: RepairRequest): Promise<RepairProposal> {
        asks += 1;
        void request;
        return {
          canFix: true,
          insertBefore: [],
          replacement: { action: 'click', selector: `#still-wrong-${asks}`, intent: 'the go button' },
          rewriteFollowing: [],
          reasoning: `guess ${asks}`,
        };
      },
    };

    const bundle = await runFlow(
      {
        name: 'reconstruction exhausted',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#totally-wrong-id', intent: 'the go button' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'inrun-exhaust.cache.json'),
        fastTimeoutMs: 400,
        stepRepair: model,
      },
    );

    assert.notEqual(bundle.status, 'passed');
    assert.equal(asks, 2, 'failures 1 and 2 each earn an ask; the 3rd failure is final');
    // No rescue happened, so nothing is superseded — every failure counts.
    assert.ok(bundle.steps.filter((s) => s.status !== 'passed').every((s) => s.superseded === undefined));
    const finalFailure = bundle.steps.at(-1);
    assert.notEqual(finalFailure?.status, 'passed');
    assert.equal(finalFailure?.superseded, undefined, 'the final failure is the outcome, never superseded');
  });

  it('reports dead-end immediately when the model declines to propose a fix', async () => {
    const model = scriptedModel([
      { canFix: false, insertBefore: [], replacement: brokenFlow().steps[0]!, reasoning: 'app looks broken' },
    ]);

    const loop = new FlowRepairLoop({
      model,
      maxAttempts: 3,
      outDir: dir,
      runOptions: { cdpUrl: CDP_URL, cachePath: join(dir, 'repair-decline.cache.json'), fastTimeoutMs: 500 },
    });

    const outcome = await loop.run(brokenFlow(), 'declined');

    assert.equal(outcome.status, 'dead-end');
    // A declined fix stops the loop immediately — it must not burn the whole budget.
    assert.equal(outcome.attempts.length, 1);
  });

  it('reports dead-end after exhausting maxAttempts when fixes keep failing', async () => {
    const model = scriptedModel([
      {
        canFix: true,
        insertBefore: [],
        replacement: { action: 'click', selector: '#still-wrong', intent: 'the go button' },
        reasoning: 'guess 1',
      },
      {
        canFix: true,
        insertBefore: [],
        replacement: { action: 'click', selector: '#also-wrong', intent: 'the go button' },
        reasoning: 'guess 2',
      },
    ]);

    const loop = new FlowRepairLoop({
      model,
      maxAttempts: 3,
      outDir: dir,
      runOptions: { cdpUrl: CDP_URL, cachePath: join(dir, 'repair-exhaust.cache.json'), fastTimeoutMs: 500 },
    });

    const outcome = await loop.run(brokenFlow(), 'exhausted');

    assert.equal(outcome.status, 'dead-end');
    assert.equal(outcome.attempts.length, 3);
    assert.ok(outcome.attempts.every((a) => a.bundle.status !== 'passed'));
    // The last attempt must not propose yet another fix — the budget is spent.
    assert.equal(outcome.attempts[2]?.repair, undefined);
  });
});
