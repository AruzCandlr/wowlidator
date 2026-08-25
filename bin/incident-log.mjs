#!/usr/bin/env node
/**
 * Append one entry to the supervision log, and rewrite `incident.html` from it.
 *
 * The JSONL beside it is the record; the HTML is a rendering of the record.
 * That order matters: an append can never corrupt what is already logged, and
 * the page can be regenerated from the log at any time.
 *
 *   node bin/incident-log.mjs <incident.html> '<json entry>'
 *
 * An entry is { kind, title, detail, evidence?, state? }. `kind` is one of
 * `stop` (the run ended short), `diagnosis`, `fix`, `resume`, `note`, `done`.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';

/** Read the whole of stdin, for the `-` form. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const htmlPath = process.argv[2];
// The entry comes in on stdin when argv omits it or passes `-`. That is the
// form callers should use: an entry carries prose, and prose in argv is at
// the mercy of shell quoting and of whatever the platform will accept in an
// argument — measured 2026-08-26, a 989-byte entry was SIGKILLed before this
// process could read it, while the same entry on stdin is unremarkable. The
// argv form is kept for one-line probes by hand.
const raw = process.argv[3] === undefined || process.argv[3] === '-' ? await readStdin() : process.argv[3];
if (!htmlPath || raw.trim() === '') {
  console.error("usage: incident-log.mjs <incident.html> ['<json entry>' | - ]  (entry on stdin by default)");
  process.exit(2);
}
const logPath = htmlPath.replace(/\.html$/, '') + '.jsonl';

const entry = { at: new Date().toISOString(), ...JSON.parse(raw) };
await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');

let entries = [];
try {
  entries = (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
} catch {
  entries = [entry];
}

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const KIND = {
  stop: ['#b4232b', 'the run stopped short'],
  diagnosis: ['#8a5a00', 'what was wrong'],
  fix: ['#1f6f43', 'what was changed'],
  resume: ['#2a5d9f', 'the run was restarted'],
  note: ['#555', 'note'],
  done: ['#1f6f43', 'every case reached'],
};

const rows = entries
  .map((one) => {
    const [colour, label] = KIND[one.kind] ?? KIND.note;
    const state = one.state
      ? `<p class="state">${esc(one.state.recorded)} of ${esc(one.state.planned)} cases recorded${
          one.state.byVerdict
            ? ` · ${Object.entries(one.state.byVerdict)
                .map(([k, v]) => `${esc(k)} ${esc(v)}`)
                .join(' · ')}`
            : ''
        }</p>`
      : '';
    return `<article class="entry">
      <header><span class="kind" style="--k:${colour}">${esc(label)}</span>
        <time>${esc(one.at)}</time></header>
      <h2>${esc(one.title)}</h2>
      ${one.detail ? `<p>${esc(one.detail).replace(/\n/g, '<br>')}</p>` : ''}
      ${state}
      ${one.evidence ? `<pre>${esc(one.evidence)}</pre>` : ''}
    </article>`;
  })
  .reverse()
  .join('\n');

const last = entries[entries.length - 1];
await writeFile(
  htmlPath,
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Run supervision — incidents</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{--bg:#fbfaf8;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e3e0da;--card:#fff}
 @media (prefers-color-scheme:dark){:root{--bg:#151513;--fg:#eceae6;--muted:#9a978f;--line:#2c2c28;--card:#1d1d1a}}
 *{box-sizing:border-box}
 body{margin:0;padding:32px 20px;background:var(--bg);color:var(--fg);
   font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
 main{max-width:820px;margin:0 auto}
 h1{font-size:24px;margin:0 0 4px}
 .sub{color:var(--muted);margin:0 0 28px}
 .entry{background:var(--card);border:1px solid var(--line);border-radius:10px;
   padding:16px 18px;margin-bottom:14px}
 .entry header{display:flex;gap:10px;align-items:center;margin-bottom:6px}
 .kind{color:#fff;background:var(--k);border-radius:99px;padding:2px 10px;
   font-size:11px;letter-spacing:.04em;text-transform:uppercase}
 time{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
 h2{font-size:16px;margin:0 0 6px;font-weight:600}
 p{margin:0 0 8px}
 .state{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
 pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;
   padding:10px 12px;overflow-x:auto;font-size:12.5px;margin:8px 0 0;white-space:pre-wrap}
</style></head><body><main>
<h1>Run supervision — incidents</h1>
<p class="sub">${esc(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'} · newest first · last ${esc(last?.at ?? '')}</p>
${rows}
</main></body></html>
`,
  'utf8',
);
console.log(`${entry.kind}: ${entry.title}`);
