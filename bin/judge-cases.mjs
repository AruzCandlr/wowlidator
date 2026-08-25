#!/usr/bin/env node
/**
 * A second opinion on every case, from a model that sees only the evidence.
 *
 * The suite grades itself against the sheet's recorded Actual Result, which
 * gives one confusion matrix. This gives a second one from an independent
 * judge over the same evidence, so the two can be compared: where they agree,
 * the verdict is worth trusting; where they differ, one of them is wrong and
 * the case deserves a person's eye.
 *
 * **The judge is blind on purpose.** It is shown the claim and the run's own
 * record of what happened, and NEVER the sheet's known result or the suite's
 * verdict. Showing either would make agreement meaningless — the thing being
 * measured is whether the evidence supports the claim, not whether a model
 * can echo an answer it was handed.
 *
 * It also runs from a neutral directory, so the project's CLAUDE.md — which
 * explains this system's own grading philosophy — cannot lean on it.
 *
 *   node bin/judge-cases.mjs <ledger.progress.json> <judged.jsonl> [--limit N]
 *
 * Resumable: a case already in the output is skipped. 108 calls is real money,
 * and an interrupted judge must never re-buy what it has already paid for.
 */
import { appendFile, readFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [, , ledgerPath, outPath, ...rest] = process.argv;
if (!ledgerPath || !outPath) {
  console.error('usage: judge-cases.mjs <ledger.progress.json> <judged.jsonl> [--limit N]');
  process.exit(2);
}
const limitAt = rest.indexOf('--limit');
const limit = limitAt === -1 ? Infinity : Number(rest[limitAt + 1] ?? Infinity);

const MODEL = process.env['JUDGE_MODEL'] ?? 'fable';
const EFFORT = process.env['JUDGE_EFFORT'] ?? 'high';
/** How much of one step's error text the judge sees. Enough to rule on; not a wall. */
const ERROR_CHARS = 400;
const MAX_STEPS = 40;

const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
const outcomes = Object.entries(ledger.outcomes ?? {});

let done = new Set();
try {
  done = new Set(
    (await readFile(outPath, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line).case),
  );
} catch {
  /* first run */
}

/** What happened, as the run itself recorded it — no grade attached. */
function evidenceOf(bundle) {
  const steps = (bundle.steps ?? [])
    .filter((step) => !step.superseded)
    .slice(0, MAX_STEPS)
    .map((step) => {
      const target = step.selector ?? step.request?.url ?? '';
      const detail = step.detail ?? {};
      const compare =
        detail.expected === undefined
          ? ''
          : ` [expected ${JSON.stringify(detail.expected)}${
              detail.actual === undefined ? '' : `, actual ${JSON.stringify(detail.actual)}`
            }]`;
      const outcome = step.status === 'passed' ? 'ok' : step.status.toUpperCase();
      const why = step.error ? ` — ${String(step.error).slice(0, ERROR_CHARS)}` : '';
      return `${step.index}. ${step.action} ${target}${compare} → ${outcome}${why}${
        step.intent ? `\n     intent: ${step.intent}` : ''
      }`;
    });
  return steps.join('\n');
}

function promptFor(bundle, id) {
  const g = bundle.generatedBy ?? {};
  return `You are judging whether a web application behaved correctly, from the record of one automated test run. Answer only from the evidence below.

CASE: ${id} — ${g.caseTitle ?? bundle.name ?? ''}
SCENARIO: ${g.scenario ?? '(none recorded)'}
THE CLAIM THIS CASE IS MEANT TO PROVE, in the test author's words:
${g.rationale ? `  ${g.rationale}\n` : ''}  ${bundle.name ?? ''}
POLARITY: ${bundle.polarity ?? 'unstated'} (a negative case is meant to show the application REFUSING something; for one of those, a refusal is correct behaviour)

WHAT THE RUN RECORDED, step by step:
${evidenceOf(bundle)}

Judge the APPLICATION, not the test. Those differ, and the difference is the whole point:
- If a step failed because the application did the wrong thing, that is the application failing.
- If a step failed because the TEST was wrong — it looked for a control by the wrong name, asserted a value the page never claimed to show, called an endpoint that does not exist, or expected data that another case had changed — the application did not fail.
- If the run never reached the point of proving anything — it could not sign in, the harness errored, a model was unavailable, a step was blocked — then there is no evidence either way.

Reply with ONE line of JSON and nothing else:
{"verdict":"passed"|"failed"|"no-evidence","confidence":0.0-1.0,"why":"<one sentence, under 200 characters>"}

"passed" = the evidence shows the application behaving correctly for this claim.
"failed" = the evidence shows the application behaving incorrectly.
"no-evidence" = the run does not settle it either way. Prefer this to a guess.`;
}

const neutral = await mkdtemp(join(tmpdir(), 'wowlidator-judge-'));
let judged = 0;

for (const [id, outcome] of outcomes) {
  if (judged >= limit) break;
  if (done.has(id)) continue;
  if (!outcome.proofPath) {
    await appendFile(
      outPath,
      JSON.stringify({ case: id, verdict: 'no-evidence', confidence: 1, why: 'the case produced no proof bundle', model: null }) + '\n',
      'utf8',
    );
    continue;
  }

  let bundle;
  try {
    bundle = JSON.parse(await readFile(outcome.proofPath, 'utf8'));
  } catch (error) {
    await appendFile(
      outPath,
      JSON.stringify({ case: id, verdict: 'no-evidence', confidence: 1, why: `bundle unreadable: ${error.message}`, model: null }) + '\n',
      'utf8',
    );
    continue;
  }

  let answer = { verdict: 'no-evidence', confidence: 0, why: 'the judge did not answer' };
  try {
    const { stdout } = await run(
      'claude',
      ['-p', '--model', MODEL, '--effort', EFFORT, '--output-format', 'json', promptFor(bundle, id)],
      { cwd: neutral, maxBuffer: 8 * 1024 * 1024, timeout: 300_000 },
    );
    const envelope = JSON.parse(stdout);
    const text = String(envelope.result ?? '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) answer = JSON.parse(match[0]);
    answer.costUsd = envelope.total_cost_usd ?? null;
  } catch (error) {
    answer = { verdict: 'no-evidence', confidence: 0, why: `judge failed: ${String(error.message).slice(0, 200)}` };
  }

  await appendFile(
    outPath,
    JSON.stringify({ case: id, ...answer, model: `${MODEL}/${EFFORT}`, at: new Date().toISOString() }) + '\n',
    'utf8',
  );
  judged += 1;
  process.stderr.write(`${id} → ${answer.verdict}\n`);
}

process.stderr.write(`judged ${judged} case(s)\n`);
