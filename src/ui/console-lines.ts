/**
 * Reading one job's output, line by line, on the page.
 *
 * The panel forwards whatever `wowlidator <command>` prints — nothing is
 * rewritten on the way (src/ui/CLAUDE.md, "It runs the CLI; it does not
 * reimplement it"). What this module adds is a *reading* of each line, done
 * in the browser after the fact: is it a model call, a step verdict, a
 * refusal and its numbered problems, a phase marker, a two-column summary,
 * or prose? The output itself is the source of truth; the classification
 * only decides how the line is laid out and which filter it answers to. A
 * line the classifier does not recognise is shown as it came, so a new line
 * shape in the CLI degrades to plain text, never to a dropped line.
 *
 * Plain ES5-style JavaScript in a string, for two reasons: it is shipped
 * verbatim inside `WOW_SCRIPT` (so both pages read output the same way), and
 * the tests evaluate the same string with `new Function` and drive the
 * classifier with sample lines — the page-string tests then only need to
 * assert the page contains it.
 *
 * The shapes it reads are the ones `src/log-format.ts`,
 * `formatStepLine`/`formatAgentAction` (engine/proof-bundle.ts) and
 * `formatRefusalLines` (generator/flow-author.ts) write, plus the older
 * forms they replaced (target before duration, `·` bullets, a doubled id),
 * because a log on disk from last week is read by the same page. Every
 * pattern keys on the *structure* a line cannot lose without changing
 * meaning — a bracketed tag, an arrow, a ✓/✗ glyph, `refused:`, a numbered
 * or bulleted item, a rule of dashes, a two-column `key   value` — and never
 * on a case's wording (tests/no-hardcode.test.ts).
 */
export const CONSOLE_LINES_SCRIPT = String.raw`
/* ---- console lines: how one output line is read (src/ui/console-lines.ts) ---- */

/* "[c3] " — the case tag every line of a running case carries. Already
   stripped in a case's own pane, present in the job-wide one. */
var CON_CASE_TAG = /^\[c(\d+)\]\s?/;
/* "[ACME-042] " — the tag every line of a row being authored carries: one
   bracketed token, no spaces, at least one letter. "[llm 12:00:00]" has a
   space and never matches; "[3]" has no letter and never matches; a bare
   "[llm]" is the model channel, not a case. */
var CON_CASE_ID = /^\[((?=[^\]\s]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,63})\]\s?/;
/* "[llm HH:MM:SS] → …" / "← …" / "✗ …", or a free-form pacing note. The
   tag comes AFTER the case tag: "[ACME-042] [llm 06:41:47] → generator …". */
var CON_LLM = /^\[llm(?:\s+([\d:]{5,8}))?\]\s*(→|←|✗|->|<-)?\s*([\s\S]*)$/;
/* The continuation lines under a model call: "         ask: …" / "response: …". */
var CON_LLM_CONT = /^\s+(ask|response|prompt|answer|error|tool):\s?([\s\S]*)$/;
/* A step verdict: a glyph, then the columns. Agent turns are indented two
   and put "agent" where the index would be. */
var CON_STEP = /^\s*([✓✗])\s+([\s\S]*)$/;
/* Columns: "[7]   click          (fast, 812ms)  role=button[…]  DEAD END".
   Duration right after the action (the current shape) … */
var CON_STEP_COLS = /^(?:\[(\d+)\]\s+)?(agent\s+\S+|\S+)\s+\(((?:[\w-]+,\s*)?\d+ms)\)(?:\s+([\s\S]*?))?\s*$/;
/* … or after the target (the shape before 2026-09-04), or none at all. */
var CON_STEP_TAIL = /^(?:\[(\d+)\]\s+)?(agent\s+\S+|\S+)(?:\s+([\s\S]*?))?\s*(?:\(((?:[\w-]+,\s*)?\d+ms)\))?\s*$/;
var CON_REFUSAL = /(?:^|\s)refused:\s/;
/* The items under a refusal: "  (1) …" numbered, "  · …" bulleted (older),
   and the "  flow: "…"" line that names the flow once. */
var CON_ITEM = /^\s+(\(\d+\)|[·•▪‣])\s+([\s\S]*)$/;
var CON_FLOW_LINE = /^\s+flow:\s+([\s\S]*)$/;
/* A line indented four or more that is nobody's headline: the wrapped
   continuation of a refusal item (six spaces), a step's detail (eight), an
   agent turn's note (ten). Whose it is depends on the line above, which is
   the view's call, not this function's. */
var CON_HANG = /^\s{4,}(\S[\s\S]*)$/;
/* "— authoring attempt 2/3 —", "asking again … (attempt 2/3)…". Anchored so a
   summary that mentions "on attempt 2/3" does not read as a marker. */
var CON_ATTEMPT = /^\s*[—–-]?\s*(?:[A-Za-z-]+\s+)?attempt \d+(?:\/\d+)?\s*[—–-]?\s*$|^asking again\b|^retrying\b/i;
var CON_LLM_ATTEMPT = /\(attempt \d+(?:\/\d+)?\)/;
var CON_CASE_EDGE = /^case "(.+)" (started|passed-with-issues|needs-review|passed|failed|error|dead-end|blocked)$/;
/* A phase header: a rule of dashes with a label — "── authoring ACME-042 ───…" —
   or the other shapes one may take ("## run", "phase: …", "▶ …"). */
var CON_PHASE = /^(?:[=─—#]{2,}\s*\S[\s\S]*|phase\b[\s\S]*|[▶»]\s[\s\S]*)$/;
/* "  authored   57 step(s) on attempt 2/3 in 4m31s", "  plan       57 step(s)",
   "  report     /path" — the two-column summary the CLI writes: a word, two
   or more spaces, a value. */
var CON_SUMMARY = /^\s{1,3}([a-z][a-z-]*)\s{2,}(\S[\s\S]*)$/;
/* What the "problems" filter keeps besides ✗, refusals and failed calls. */
var CON_PROBLEM = /^\s*!\s|\bBLOCKED\b|\bDEAD END\b|\bERROR\b|\bno verdict\b|\bstalled\b|\bcould not\b|\bfailed\b|\berror\b/i;

function conEscapeRe(s) { return s.replace(/[.*+?^$(){}|[\]\\\/]/g, '\\$&'); }

/**
 * Read one line. Never throws, never drops: the worst case is kind 'plain'
 * with the text untouched. Prefixes are peeled in the order the CLI stacks
 * them — the case tag, the row tag, then the llm channel tag — and the rest
 * is what the row shows.
 */
function classifyLine(text) {
  var raw = String(text === undefined || text === null ? '' : text);
  var c = { kind: 'plain', caseNo: null, caseId: null, body: raw, time: null, glyph: '', index: null, action: null, rest: null, took: null, label: null, edge: null, problem: false, hang: false };
  var m = CON_CASE_TAG.exec(c.body);
  if (m) { c.caseNo = Number(m[1]); c.body = c.body.slice(m[0].length); }

  m = CON_CASE_ID.exec(c.body);
  if (m && m[1] !== 'llm') {
    c.caseId = m[1];
    c.body = c.body.slice(m[0].length);
    /* The same id repeated as an "ID: …" prefix on the message (a shape the
       CLI no longer prints, but logs on disk still carry) says nothing the
       label above the group does not; fold it. Structural — the token is the
       one just peeled — never a known id. */
    var doubled = new RegExp('^\\s*' + conEscapeRe(c.caseId) + ':\\s*');
    if (doubled.test(c.body)) c.body = c.body.replace(doubled, '');
  }

  m = CON_LLM.exec(c.body);
  if (m) {
    c.time = m[1] || null;
    var arrow = m[2] || '';
    c.body = m[3];
    if (arrow === '→' || arrow === '->') { c.kind = 'llm-req'; c.glyph = '→'; }
    else if (arrow === '←' || arrow === '<-') { c.kind = 'llm-res'; c.glyph = '←'; }
    else if (arrow === '✗') { c.kind = 'llm-fail'; c.glyph = '✗'; c.problem = true; }
    else { c.kind = 'llm-note'; c.glyph = '·'; }
    if (CON_LLM_ATTEMPT.test(c.body)) c.label = 'retry';
    return c;
  }

  m = CON_LLM_CONT.exec(c.body);
  if (m) { c.kind = 'llm-cont'; c.label = m[1]; c.body = m[2]; return c; }

  m = CON_STEP.exec(c.body);
  if (m) {
    c.kind = m[1] === '✓' ? 'step-pass' : 'step-fail';
    c.glyph = m[1];
    c.problem = m[1] === '✗';
    var p = CON_STEP_COLS.exec(m[2]);
    if (p) { c.index = p[1] ? Number(p[1]) : null; c.action = p[2].replace(/\s+/g, ' '); c.took = p[3]; c.rest = p[4] || ''; }
    else {
      p = CON_STEP_TAIL.exec(m[2]);
      if (p) { c.index = p[1] ? Number(p[1]) : null; c.action = p[2].replace(/\s+/g, ' '); c.rest = p[3] || ''; c.took = p[4] || null; }
      else { c.action = m[2]; c.rest = ''; }
    }
    if (/\b(DEAD END|ERROR)$/.test(c.rest)) c.problem = true;
    return c;
  }

  m = CON_ITEM.exec(c.body);
  if (m) { c.kind = 'bullet'; c.glyph = m[1].length > 1 ? m[1] : '·'; c.body = m[2]; return c; }
  m = CON_FLOW_LINE.exec(c.body);
  if (m) { c.kind = 'bullet'; c.glyph = 'flow:'; c.label = 'flow'; c.body = m[1]; return c; }

  if (CON_REFUSAL.test(c.body)) { c.kind = 'refusal'; c.glyph = '!'; c.problem = true; return c; }

  m = CON_CASE_EDGE.exec(c.body);
  if (m) {
    c.kind = 'marker'; c.glyph = '›'; c.edge = m[2]; c.label = 'case';
    c.problem = m[2] === 'failed' || m[2] === 'error' || m[2] === 'dead-end' || m[2] === 'blocked';
    return c;
  }
  if (CON_ATTEMPT.test(c.body)) { c.kind = 'marker'; c.glyph = '↻'; c.label = 'retry'; c.body = c.body.trim(); return c; }
  if (CON_PHASE.test(c.body)) {
    c.kind = 'marker'; c.glyph = '›'; c.label = 'phase';
    /* The rule is the reader's cue on a terminal; on the page the row's own
       border is, so the label stands alone: "── run ACME-042 ────" → "run ACME-042". */
    c.body = c.body.replace(/^[=─—#]+\s*/, '').replace(/\s*[=─—#]{2,}\s*$/, '');
    return c;
  }

  m = CON_SUMMARY.exec(c.body);
  if (m) {
    c.kind = 'summary'; c.label = m[1]; c.body = m[2];
    c.problem = CON_PROBLEM.test(c.body);
    return c;
  }

  m = CON_HANG.exec(c.body);
  /* Hanging text is shown under the row it belongs to, which indents it
     itself; the leading spaces would only indent it twice. The raw line is
     kept whole for search and for "Copy raw". */
  if (m) { c.hang = true; c.body = m[1]; }
  c.problem = CON_PROBLEM.test(c.body);
  return c;
}

/** The group a line sits under: its case id, else its case number, else none. */
function conGroupLabel(c) {
  if (c.caseId) return c.caseId;
  if (c.caseNo !== null && c.caseNo !== undefined) return 'c' + c.caseNo;
  return null;
}

/* The four ways to read a log. Persisted per browser (a view preference,
   never server state). */
var CON_FILTERS = [
  ['all', 'All', 'every line, as printed'],
  ['steps', 'Steps', 'step verdicts, agent turns and case boundaries only'],
  ['model', 'Model calls', 'model requests, responses and failures only'],
  ['problems', 'Problems', 'failed steps, refusals, failed model calls, blocked and no-verdict lines']
];

/** Whether one classified line answers to a filter mode. */
function conMatchesMode(c, mode) {
  if (mode === 'steps') return c.kind === 'step-pass' || c.kind === 'step-fail' || (c.kind === 'marker' && c.label === 'case');
  if (mode === 'model') return c.kind.slice(0, 4) === 'llm-';
  if (mode === 'problems') return c.problem === true || c.kind === 'refusal' || c.kind === 'step-fail' || c.kind === 'llm-fail';
  return true;
}

/** Case-insensitive substring search over the raw text of a row (and what it folds). */
function conMatchesQuery(haystack, query) {
  var q = String(query || '').trim().toLowerCase();
  if (q === '') return true;
  return String(haystack || '').toLowerCase().indexOf(q) !== -1;
}

/** The log as the terminal showed it: every line, stderr and stdout interleaved, nothing reformatted. */
function conRawText(lines) {
  return (lines || []).map(function (line) { return line.text || ''; }).join('\n');
}
`;
