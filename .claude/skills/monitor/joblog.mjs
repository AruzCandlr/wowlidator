#!/usr/bin/env node
// Dump a wowlidator panel job's output for diagnosis.
//   node .claude/skills/monitor/joblog.mjs [latest|job-N] [summary|all] [port]
// summary: the llm timeline (→/← with durations and tokens), phase markers,
// refusals, every step verdict with its duration. all: every line.
const id = process.argv[2] || 'latest';
const mode = process.argv[3] || 'summary';
const port = process.argv[4] || '4600';
const base = `http://localhost:${port}`;
const { jobs } = await (await fetch(`${base}/api/jobs`)).json();
if (!jobs?.length) { console.log('no jobs'); process.exit(0); }
const pick = id === 'latest' ? (jobs.find((j) => j.status === 'running') ?? jobs[0]) : jobs.find((j) => j.id === id);
if (!pick) { console.log(`no job ${id}; have: ${jobs.map((j) => `${j.id}:${j.status}`).join(' ')}`); process.exit(1); }
const { job } = await (await fetch(`${base}/api/jobs/${pick.id}`)).json();
console.log(`# ${job.id} ${job.status} exit=${job.exitCode} started=${job.startedAt} finished=${job.finishedAt ?? '-'} cases=${job.cases?.length ?? 0} lines=${job.lines.length}`);
console.log(`# ${job.commandLine}`);
// Every line may carry a case tag in front — `[c3]` for a lane, `[HIR-EC-001]`
// for a row being authored — on stdout AND stderr (the llm log is tagged
// too). Matching is done on the line with the tag stripped.
const untag = (t) => t.replace(/^\[[^\]\s]+\] ?/, '');
const keep = /^\[llm .*(←|→)|^got |^refused|^  \(\d+\) |^  · |^asking|^review|^kept|^weak|^wrote|^authored|^  authored |^  elapsed |^── |^— |^    model|^queued|^  queued|^the model|^opening|^capture|^[✓✗] \[|^  [✓✗] agent|stalled|blocked|^wowlidator|could not|^  ! /;
for (const [i, l] of job.lines.entries()) {
  const t = l.text || '';
  if (mode === 'all' || keep.test(untag(t))) console.log(String(i).padStart(4), (l.stream === 'err' ? 'E ' : '  ') + t.slice(0, 300));
}
// Totals: model time per role, step time by verdict, slowest steps.
const llm = new Map();
for (const l of job.lines) {
  const m = /^\[llm [\d:]+\] ← (\S+) · (\S+) · ([\d.]+)s · (\d+) in \/ (\d+) out/.exec(untag(l.text || ''));
  if (!m) continue;
  const k = `${m[1]} ${m[2]}`; const e = llm.get(k) ?? { calls: 0, s: 0, in: 0, out: 0 };
  e.calls += 1; e.s += Number(m[3]); e.in += Number(m[4]); e.out += Number(m[5]); llm.set(k, e);
}
console.log('\n# model time');
for (const [k, e] of llm) console.log(`  ${k}: ${e.calls} call(s), ${e.s.toFixed(1)}s, ${e.in} in / ${e.out} out`);
const steps = [];
for (const l of job.lines) {
  // `✓ [3]   fill             (7ms)  input[type="password"]` — mark, index,
  // action and duration in columns, the target (and ERROR / DEAD END) after.
  const m = /^([✓✗]) \[(\d+)\]\s+(\S+)\s+\((?:\w+, )?(\d+)ms\)(?:\s+(.*))?$/.exec(untag(l.text || ''));
  if (m) steps.push({ ok: m[1] === '✓', idx: Number(m[2]), action: m[3], sel: m[5] ?? '', ms: Number(m[4]) });
}
const sum = (xs) => xs.reduce((a, s) => a + s.ms, 0);
console.log(`# steps: ${steps.length}, ${(sum(steps) / 1000).toFixed(1)}s; failed ${steps.filter((s) => !s.ok).length} (${(sum(steps.filter((s) => !s.ok)) / 1000).toFixed(1)}s)`);
console.log('# slowest steps');
for (const s of [...steps].sort((a, b) => b.ms - a.ms).slice(0, 8)) console.log(`  ${s.ok ? '✓' : '✗'} [${s.idx}] ${s.action} ${s.sel.slice(0, 70)} ${(s.ms / 1000).toFixed(1)}s`);
