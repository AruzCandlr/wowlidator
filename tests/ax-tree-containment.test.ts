/**
 * The AX capture's containment: `AxNode.depth`, `formatAxTree`'s indentation,
 * and the two places a SUBSET of a tree is chosen (`captureAxTreeDetailed`'s
 * node budget, `focusTreeText`'s relevance narrowing).
 *
 * Unit tier, and the CDP payloads are hand-built: a reader tested only against
 * its own writer proves nothing, so the fixtures here are the shapes Chrome
 * actually emits — a `generic` between a landmark and its input, a `row` left
 * unnamed, a parent listed after its child.
 *
 * The rule under test in one sentence: an indent may only say something TRUE
 * about containment, because a wrong one reads as authority — see `AxNode.depth`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Page } from 'playwright';

import {
  ancestorIndexes,
  captureAxNodes,
  captureAxTree,
  formatAxNode,
  formatAxTree,
  keepWithAncestors,
  type AxNode,
} from '../src/healer/jit-healer.js';
import { focusTreeText } from '../src/context/retriever.js';

interface Cdp {
  id: string;
  role: string;
  name?: string;
  children?: string[];
  ignored?: boolean;
}

/** A page whose only real behaviour is answering `Accessibility.getFullAXTree`. */
function fakePage(nodes: readonly Cdp[]): Page {
  const payload = nodes.map((n) => ({
    nodeId: n.id,
    ...(n.ignored === true ? { ignored: true } : {}),
    role: { value: n.role },
    name: { value: n.name ?? '' },
    ...(n.children === undefined ? {} : { childIds: n.children }),
    properties: [],
  }));
  return {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) =>
          method === 'Accessibility.getFullAXTree' ? { nodes: payload } : {},
        detach: async () => undefined,
      }),
    }),
  } as unknown as Page;
}

/**
 * The shape that cost the run: a landmark whose input is two `generic`s below
 * it, a table whose rows Chrome leaves unnamed, and a sidebar that is nobody's
 * container. Document order alone cannot tell any of them apart.
 */
const PAGE: Cdp[] = [
  { id: '0', role: 'RootWebArea', name: 'Benefit Plans', children: ['1', '2'] },
  { id: '1', role: 'navigation', name: 'Main', children: ['1a', '1b'] },
  { id: '1a', role: 'link', name: 'Home' },
  { id: '1b', role: 'link', name: 'Benefit Plans' },
  { id: '2', role: 'main', name: 'Content', children: ['3', '6'] },
  { id: '3', role: 'generic', children: ['4'] },
  { id: '4', role: 'search', name: 'ค้นหา', children: ['5'] },
  { id: '5', role: 'generic', children: ['5a'] },
  { id: '5a', role: 'searchbox', name: '' },
  { id: '6', role: 'table', name: 'Plans', children: ['7'] },
  { id: '7', role: 'row', name: '', children: ['7a', '7b'] },
  { id: '7a', role: 'cell', name: 'QA-Delete' },
  { id: '7b', role: 'button', name: 'Delete' },
];

const byName = (nodes: readonly AxNode[], name: string): AxNode =>
  nodes.find((n) => n.name === name) as AxNode;

describe('depth comes from CDP parentage, not document order', () => {
  it('indents a landmark\'s input under the landmark', async () => {
    const tree = await captureAxTree(fakePage(PAGE));
    assert.match(tree, /^ {4}search "ค้นหา"\n {6}searchbox$/m);
  });

  it('a pruned generic creates no level — the child reattaches to the nearest printed ancestor', async () => {
    const nodes = await captureAxNodes(fakePage(PAGE));
    // RootWebArea 0 → main 1 → search 2: the two `generic`s between main and
    // search, and between search and the searchbox, contribute nothing.
    assert.equal(byName(nodes, 'Content').depth, 1);
    assert.equal(byName(nodes, 'ค้นหา').depth, 2);
    assert.equal(nodes.find((n) => n.role === 'searchbox')?.depth, 3);
  });

  it('a sibling that merely FOLLOWS is not inside', async () => {
    const nodes = await captureAxNodes(fakePage(PAGE));
    // The table follows the search landmark in document order and is not in it.
    assert.equal(byName(nodes, 'Plans').depth, byName(nodes, 'ค้นหา').depth);
  });

  it('reads parentage even when a parent is listed after its child', async () => {
    const inverted: Cdp[] = [
      { id: 'root', role: 'RootWebArea', name: 'P', children: ['box'] },
      { id: 'kid', role: 'button', name: 'Inside' },
      { id: 'box', role: 'dialog', name: 'Confirm', children: ['kid'] },
    ];
    const nodes = await captureAxNodes(fakePage(inverted));
    assert.equal(byName(nodes, 'Confirm').depth, 1);
    assert.equal(byName(nodes, 'Inside').depth, 2, 'parentage, not the order it arrived in');
  });

  it('an ignored node is not a level either', async () => {
    const nodes = await captureAxNodes(
      fakePage([
        { id: 'r', role: 'RootWebArea', name: 'P', children: ['i'] },
        { id: 'i', role: 'region', name: 'Hidden', ignored: true, children: ['b'] },
        { id: 'b', role: 'button', name: 'Go' },
      ]),
    );
    assert.equal(byName(nodes, 'Go').depth, 1);
  });

  it('survives a malformed parent cycle rather than hanging the repair', async () => {
    const nodes = await captureAxNodes(
      fakePage([
        { id: 'a', role: 'button', name: 'A', children: ['b'] },
        { id: 'b', role: 'button', name: 'B', children: ['a'] },
      ]),
    );
    assert.equal(nodes.length, 2);
  });
});

describe('formatAxTree', () => {
  const node = (role: string, name: string, depth?: number): AxNode => ({
    role,
    name,
    value: '',
    description: '',
    disabled: false,
    checked: false,
    url: '',
    ...(depth === undefined ? {} : { depth }),
  });

  it('renders hand-built nodes flat — an older capture keeps its shape', () => {
    const out = formatAxTree([node('button', 'A'), node('textbox', 'B')]);
    assert.equal(out, 'button "A"\ntextbox "B"');
  });

  it('formatAxNode itself never emits leading whitespace', () => {
    assert.equal(formatAxNode(node('button', 'A', 4)), 'button "A"');
  });

  it('indents two spaces per level', () => {
    const out = formatAxTree([node('table', 'Plans', 1), node('row', 'R', 2), node('button', 'Delete', 3)]);
    assert.equal(out, 'table "Plans"\n  row "R"\n    button "Delete"');
  });

  it('never indents deeper than the lines actually present', () => {
    // The row was dropped; its button may not claim a level the tree does not
    // show, or the indent would name a container nobody can read.
    const out = formatAxTree([node('table', 'Plans', 1), node('button', 'Delete', 3)]);
    assert.equal(out, 'table "Plans"\n  button "Delete"');
  });
});

describe('a chosen subset is closed under containment', () => {
  const rows: AxNode[] = [
    { role: 'table', name: 'Plans', value: '', description: '', disabled: false, checked: false, url: '', depth: 0 },
    { role: 'row', name: 'One', value: '', description: '', disabled: false, checked: false, url: '', depth: 1 },
    { role: 'button', name: 'Delete', value: '', description: '', disabled: false, checked: false, url: '', depth: 2 },
    { role: 'row', name: 'Two', value: '', description: '', disabled: false, checked: false, url: '', depth: 1 },
    { role: 'button', name: 'Delete', value: '', description: '', disabled: false, checked: false, url: '', depth: 2 },
  ];

  it('ancestorIndexes walks the printed chain, outermost first', () => {
    assert.deepEqual(ancestorIndexes(rows, 4), [0, 3]);
    assert.deepEqual(ancestorIndexes(rows, 0), []);
  });

  it('keepWithAncestors brings the containers and returns document order', () => {
    assert.deepEqual(keepWithAncestors(rows, [4, 2], 10), [0, 1, 2, 3, 4]);
  });

  it('skips a candidate whose containers do not fit rather than orphaning it', () => {
    // Budget 2: the first candidate needs three lines, the next needs three
    // too — neither may arrive bare, so the budget goes to what fits.
    assert.deepEqual(keepWithAncestors(rows, [4, 2, 0], 2), [0]);
  });

  it('the node budget never leaves a child under a parent it cut', async () => {
    // Six printed nodes, budget four: whatever survives must still describe
    // real containment, and the notice must still be there.
    const tree = await captureAxTree(fakePage(PAGE), 4);
    assert.match(tree, /TREE TRUNCATED: showing 4 of \d+ nodes/);
    assertIndentsAreGrounded(tree);
  });
});

describe('relevance narrowing keeps a line\'s containers', () => {
  const tree = [
    'table "Plans"',
    '  row "QA-Delete plan"',
    '    button "Delete"',
    ...Array.from({ length: 30 }, (_, i) => `  link "Unrelated ${i}"`),
  ].join('\n');

  it('a kept control arrives with the row it is in', () => {
    const { text } = focusTreeText(tree, 'delete the QA-Delete plan row', 3);
    assert.match(text, /^table "Plans"\n {2}row "QA-Delete plan"\n {4}button "Delete"/);
  });

  it('narrowed output never indents a line under a container it dropped', () => {
    for (const budget of [2, 3, 5, 8, 20]) {
      assertIndentsAreGrounded(focusTreeText(tree, 'delete', budget).text);
    }
  });

  it('is the selection it always was on flat text', () => {
    const flat = [
      'button "Create Benefit Plan"',
      ...Array.from({ length: 20 }, (_, i) => `button "Control ${i}"`),
    ].join('\n');
    const { text, kept } = focusTreeText(flat, 'create benefit plan', 5);
    assert.equal(kept, 5);
    assert.equal(text.split('\n')[0], 'button "Create Benefit Plan"');
    assert.doesNotMatch(text.split('\n').slice(0, 5).join('\n'), /^ /m);
  });
});

/**
 * Every indented line has a line above it exactly one level shallower.
 *
 * That is the whole contract: an indent is a claim of containment, and this is
 * the claim being checkable from the text alone — which is all the model gets.
 */
function assertIndentsAreGrounded(text: string): void {
  let previous = -1;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('[')) continue;
    const indent = (/^ */.exec(line) as RegExpExecArray)[0].length;
    assert.equal(indent % 2, 0, `indent is whole levels: ${JSON.stringify(line)}`);
    assert.ok(indent / 2 <= previous + 1, `no line is orphaned under a dropped container: ${JSON.stringify(line)}`);
    previous = indent / 2;
  }
}
