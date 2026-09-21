/**
 * Phase 3 of the jev port: exact-node refs, the stale-ref refusal, and the
 * post-action settle. The parser and the matcher are pure and run always;
 * the loop's behaviour on a page — the ref locator clicking the exact
 * duplicate, a re-rendered page refusing the stale ref before anything is
 * touched, a combobox's options seen inside the settle window — is a fact
 * about a real browser and is CDP-gated, like every other browser fact.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { indexElements, refsFromAriaSnapshot, withRefs } from '../src/orchestrator/agent-guards.js';
import { WorkflowAgent, type AgentDecision, type AgentModel, type AgentObservation } from '../src/orchestrator/workflow-agent.js';
import { withPage } from '../src/engine/runner.js';
import type { AxNode } from '../src/healer/jit-healer.js';

process.env['WOWLIDATOR_LLM_LOG'] = 'off';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}
const skipBrowser = (await cdpAvailable(CDP_URL)) ? false : `no CDP endpoint at ${CDP_URL}`;

const SNAPSHOT = `- generic [active] [ref=e1]:
  - heading "Rows" [level=1] [ref=e2]
  - table [ref=e3]:
    - row [ref=e5]:
      - cell "Alpha" [ref=e6]
      - cell [ref=e7]:
        - button "Edit" [ref=e8]
    - row [ref=e9]:
      - cell [ref=e11]:
        - button "Edit" [ref=e12]
  - generic [ref=e13]:
    - text: City
    - combobox "City" [ref=e14]
  - listbox
  - button "Say \\"hi\\"" [ref=e15]`;

const node = (role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  role,
  name,
  value: '',
  description: '',
  disabled: false,
  checked: false,
  url: '',
  ...extra,
});

describe('refsFromAriaSnapshot — the refs by role and name, in order', () => {
  it('reads every ref-bearing line, keeps duplicates in document order, and skips lines without a ref', () => {
    const { byKey: refs, names } = refsFromAriaSnapshot(SNAPSHOT);
    assert.equal(names.get('e12'), 'Edit');
    assert.equal(names.get('e7'), '');
    assert.deepEqual(refs.get('button::Edit'), ['e8', 'e12']);
    assert.deepEqual(refs.get('heading::Rows'), ['e2']);
    assert.deepEqual(refs.get('combobox::City'), ['e14']);
    assert.deepEqual(refs.get('cell::'), ['e7', 'e11'], 'an unnamed node is keyed by its empty name');
    assert.deepEqual(refs.get('button::Say "hi"'), ['e15'], 'an escaped quote in the name is unescaped');
    assert.equal(refs.get('listbox::'), undefined, 'a line without a ref contributes nothing');
    assert.equal(refs.get('text::City'), undefined);
  });
});

describe('withRefs — a ref on every row the snapshot also names', () => {
  it('matches by role and name in duplicate order, counts the misses, and never touches a non-targetable row', () => {
    const rows = indexElements([
      node('heading', 'Rows'),
      node('button', 'Edit'),
      node('button', 'Edit'),
      node('combobox', 'City'),
      node('button', 'Only in the AX tree'),
    ]);
    const { elements, matched, missed } = withRefs(rows, refsFromAriaSnapshot(SNAPSHOT));
    assert.equal(elements[0]!.ref, undefined, 'a heading carries no operations, so no ref is spent on it');
    assert.equal(elements[1]!.ref, 'e8');
    assert.equal(elements[2]!.ref, 'e12');
    assert.equal(elements[2]!.selector, 'role=button[name="Edit" i] >> nth=1', 'the name selector stays as the floor');
    assert.equal(elements[3]!.ref, 'e14');
    assert.equal(elements[4]!.ref, undefined, 'a name Playwright does not compute the same way keeps the selector path');
    assert.equal(matched, 3);
    assert.equal(missed, 1);
  });

  it('pairs a row with its ref by document position, so a duplicate the focus cut evicted still counts (review 2026-09-18)', () => {
    const all = [node('heading', 'Rows'), node('button', 'Edit'), node('button', 'Edit'), node('combobox', 'City')];
    const focused = [all[0]!, all[2]!, all[3]!];
    const { elements } = withRefs(indexElements(focused, all), refsFromAriaSnapshot(SNAPSHOT));
    assert.equal(elements[1]!.name, 'Edit');
    assert.equal(elements[1]!.position, 1);
    assert.equal(elements[1]!.ref, 'e12', "the second Edit's ref, not the evicted first one's");
    assert.equal(elements[1]!.selector, 'role=button[name="Edit" i] >> nth=1');
  });
});

/** A policy that answers a script of decisions, each taking the ref of the row it names. */
function indexedModel(script: Array<(o: AgentObservation) => AgentDecision>): AgentModel & { seen: AgentObservation[] } {
  const seen: AgentObservation[] = [];
  let i = 0;
  return {
    id: 'stub:indexed',
    indexed: true,
    seen,
    async decide(observation) {
      seen.push(observation);
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      return step(observation);
    },
  };
}

const rowNamed = (o: AgentObservation, role: string, name: string, k = 0) =>
  o.elements!.filter((e) => e.role === role && e.name === name)[k]!;

describe('the loop acts on the exact node (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (path === '/rows') {
        res.end(`<!doctype html><title>Rows</title><body>
          <h1>Rows</h1>
          <table><tr><td>Alpha</td><td><button onclick="log('edit-alpha')">Edit</button></td></tr>
          <tr><td>Beta</td><td><button onclick="log('edit-beta')">Edit</button></td></tr></table>
          <button id="rerender" onclick="rerender()">Re-render</button>
          <pre id="log"></pre>
          <script>
            function log(m){document.getElementById('log').textContent += m + '\\n'}
            function rerender(){const t=document.querySelector('table');const h=t.outerHTML;t.remove();document.body.insertAdjacentHTML('afterbegin',h);log('rerendered')}
          </script></body>`);
        return;
      }
      if (path === '/date') {
        res.end(`<!doctype html><title>Date</title><body>
          <div class="field"><button type="button" onclick="document.getElementById('cal').hidden=false">Hire Date</button>
          <input type="date" aria-label="hire-date-input" style="opacity:0;position:absolute"></div>
          <div id="cal" hidden>calendar</div>
          </body>`);
        return;
      }
      if (path === '/combo') {
        res.end(`<!doctype html><title>Combo</title><body>
          <label>City <input role="combobox" aria-autocomplete="list" aria-controls="opts" oninput="suggest()"></label>
          <ul id="opts" role="listbox"></ul>
          <script>function suggest(){setTimeout(()=>{document.getElementById('opts').innerHTML='<li role=option>Zurich</li><li role=option>Zug</li>'},120)}</script>
          </body>`);
        return;
      }
      res.end('<!doctype html><title>x</title><body></body>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('clicks the second of two identically named buttons through its ref, and the record keeps the name selector', async () => {
    await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/rows`);
      const model = indexedModel([
        (o) => {
          const second = rowNamed(o, 'button', 'Edit', 1);
          return { action: 'click', selector: second.selector!, ref: second.ref, value: '', url: '', reasoning: 'the second Edit' };
        },
        () => ({ action: 'finish', selector: '', value: '', url: '', reasoning: 'done' }),
      ]);
      const agent = new WorkflowAgent({ model, maxSteps: 3 });
      const result = await agent.run(page, 'edit the Beta row');
      assert.notEqual(rowNamed(model.seen[0]!, 'button', 'Edit', 1).ref, undefined, 'the second button carried a ref');
      assert.equal(await page.locator('#log').innerText(), 'edit-beta\n', 'the exact node was clicked, not the first by name');
      assert.equal(result.actions[0]!.ok, true);
      assert.equal(result.actions[0]!.selector, 'role=button[name="Edit" i] >> nth=1', 'the record carries the name selector, never the ref');
      assert.ok((result.refs?.matched ?? 0) >= 2, `refs matched over the leg: ${JSON.stringify(result.refs)}`);
    });
  });

  it('a ref the page re-rendered away fails the action before anything is touched, and the next turn sees fresh refs', async () => {
    await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/rows`);
      let staleRef: string | undefined;
      const model = indexedModel([
        (o) => {
          staleRef = rowNamed(o, 'button', 'Edit', 1).ref;
          return { action: 'click', selector: 'role=button[name="Re-render" i]', ref: rowNamed(o, 'button', 'Re-render').ref, value: '', url: '', reasoning: 're-render first' };
        },
        // A decision made against the FIRST snapshot's ref, after the page changed.
        () => ({ action: 'click', selector: 'role=button[name="Edit" i] >> nth=1', ref: staleRef, value: '', url: '', reasoning: 'stale' }),
        (o) => {
          const second = rowNamed(o, 'button', 'Edit', 1);
          assert.notEqual(second.ref, staleRef, 'the next turn carries fresh refs');
          return { action: 'click', selector: second.selector!, ref: second.ref, value: '', url: '', reasoning: 'fresh' };
        },
        () => ({ action: 'finish', selector: '', value: '', url: '', reasoning: 'done' }),
      ]);
      const agent = new WorkflowAgent({ model, maxSteps: 5 });
      const result = await agent.run(page, 'edit the Beta row after a re-render');
      const stale = result.actions[1]!;
      assert.equal(stale.ok, false);
      assert.match(stale.error ?? '', /page changed since you looked/);
      assert.equal(await page.locator('#log').innerText(), 'rerendered\nedit-beta\n', 'the stale turn touched nothing; the fresh one clicked the exact node');
    });
  });

  it('a fill on a picker trigger writes the date into the input beside it (the indexed engine\'s date rung)', async () => {
    await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/date`);
      const model = indexedModel([
        () => ({ action: 'fill', selector: 'role=button[name="Hire Date" i]', value: '2027-09-01', url: '', reasoning: 'the goal gives the date' }),
        () => ({ action: 'finish', selector: '', value: '', url: '', reasoning: 'done' }),
      ]);
      const agent = new WorkflowAgent({ model, maxSteps: 3 });
      const result = await agent.run(page, 'set "Hire Date" = "2027-09-01"');
      assert.equal(result.actions[0]!.ok, true, result.actions[0]!.error ?? '');
      assert.equal(await page.locator('input[type="date"]').inputValue(), '2027-09-01');
      assert.equal(await page.locator('#cal').isHidden(), true, 'the picker was never opened');
    });
  });

  it('after typing into an editable combobox the settle waits for its options, so the next tree shows them', async () => {
    await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/combo`);
      const model = indexedModel([
        (o) => {
          const city = rowNamed(o, 'combobox', 'City');
          return { action: 'fill', selector: city.selector!, ref: city.ref, value: 'Z', url: '', reasoning: 'type' };
        },
        () => ({ action: 'finish', selector: '', value: '', url: '', reasoning: 'done' }),
      ]);
      const agent = new WorkflowAgent({ model, maxSteps: 3 });
      await agent.run(page, 'type Z into City');
      const second = model.seen[1]!;
      assert.ok(second.axTree.includes('option "Zurich"'), `the options that arrive 120 ms after typing are in the next observation:\n${second.axTree}`);
    });
  });
});
