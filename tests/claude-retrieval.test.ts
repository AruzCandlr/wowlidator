/**
 * The BM25 retrieval corpus served to claude-cli sessions — pure parts only.
 * The loopback MCP transport is proven by a live claude call (measured
 * 2026-08-27: haiku answered `time_management.ot_request` from the corpus in
 * 2 turns); what a unit can hold to account is the corpus building, the
 * ranking contract and the disclosure wording.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  claudeRetrievalCorpusSize,
  closeClaudeRetrievalServer,
  RETRIEVAL_DEFAULT_LIMIT,
  RETRIEVAL_TOOL_FULL,
  searchCorpus,
  setClaudeRetrievalCorpus,
} from '../src/providers/claude-retrieval.js';
import type { ProjectGraph } from '../src/context/types.js';

const graph = {
  version: 1,
  rootDir: '/x',
  generatedAt: 'now',
  signature: 's',
  nodes: [
    { id: 'route:app/overtime', kind: 'route', name: '/en/overtime', file: 'app/overtime/page.tsx' },
    {
      id: 'table:ot_request',
      kind: 'table',
      name: 'time_management.ot_request',
      file: 'schema.sql',
      meta: { columns: 'id, employee_id, hours' },
    },
  ],
  edges: [],
  sources: [],
} as unknown as ProjectGraph;

const spec = {
  name: 'spec.md',
  format: 'markdown' as const,
  text: '# Overtime\nOvertime requests are stored in time_management.ot_request.\n# Leave\nLeave lives elsewhere.',
  note: '',
  originalChars: 100,
};

describe('claude retrieval corpus', () => {
  afterEach(() => closeClaudeRetrievalServer());

  it('indexes document chunks and graph nodes together', () => {
    setClaudeRetrievalCorpus({ docs: [spec], graph });
    // Two headings → two chunks, plus two graph nodes.
    assert.equal(claudeRetrievalCorpusSize(), 4);
  });

  it('an emptied corpus is empty — the tool-attachment gate', () => {
    setClaudeRetrievalCorpus({ docs: [spec] });
    setClaudeRetrievalCorpus({});
    assert.equal(claudeRetrievalCorpusSize(), 0);
  });

  it('ranks the right item first and cites its source', async () => {
    setClaudeRetrievalCorpus({ docs: [spec], graph });
    const answer = await searchCorpus('which table stores overtime requests');
    assert.match(answer, /time_management\.ot_request/);
    // Attribution: a chunk names its document and heading path.
    assert.match(answer, /spec\.md › Overtime/);
    // A graph node's meta rides along, so columns are findable too.
    const columns = await searchCorpus('ot_request columns employee hours');
    assert.match(columns, /employee_id/);
  });

  it('is deterministic for identical inputs', async () => {
    setClaudeRetrievalCorpus({ docs: [spec], graph });
    assert.equal(
      await searchCorpus('overtime', RETRIEVAL_DEFAULT_LIMIT),
      await searchCorpus('overtime', RETRIEVAL_DEFAULT_LIMIT),
    );
  });

  it('every answer forbids reading absence into it', async () => {
    setClaudeRetrievalCorpus({ docs: [spec] });
    const hit = await searchCorpus('overtime');
    const miss = await searchCorpus('zzzz qqqq unrelated');
    assert.match(hit, /Never conclude/);
    assert.match(miss, /Absence here proves nothing/);
  });

  it('the tool name matches what --allowed-tools must say', () => {
    assert.equal(RETRIEVAL_TOOL_FULL, 'mcp__wow-context__search_context');
  });
});
