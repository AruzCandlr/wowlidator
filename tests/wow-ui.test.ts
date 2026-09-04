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

import { BACKEND_TIER_ACTIONS, type ProofBundle } from '../src/engine/proof-bundle.js';
import { SUPPORTED_EXTENSIONS } from '../src/catalog/extract.js';
import { COMMANDS, UiCommandError, buildArgv, commandById, buildEnvOverlay } from '../src/ui/commands.js';
import { UploadError, deleteDocument, safeName, saveDocument } from '../src/ui/uploads.js';
import { clearProofCache, groupAccuracy, groupRuns, groupScenarios, inferredCaseTitle, inferredScenario, readProof, readProofIndex, tallyVerdicts, toCard } from '../src/ui/proofs.js';
import { renderWowUi } from '../src/ui/wow-ui-html.js';
import { applyProgressLine, caseReasonOf, formatProgressReadout, type JobProgress } from '../src/ui/jobs.js';
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
    dbChecks: 0,
    dbFailures: 0,
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

  it('says in plain words, on the row, what every status word means', () => {
    // The page parses whole: a stray backtick in WOW_SCRIPT truncates the
    // document and takes the launcher with it.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const script of scripts) assert.doesNotThrow(() => new Function(script));
    // One map, the source of every meaning on both surfaces.
    assert.match(html, /var STATUS_MEANING = \{/);
    const meanings = {
      error: 'the harness, a model, a key or the environment broke — no verdict about the application was delivered',
      'dead-end': 'a control or content the case needed never resolved — the page did not offer what the case expected',
      blocked: 'not run and not failed: the case needed something that was not in place (a session that held, a database, a key, a flow authoring accepted), so nothing about the application was proved',
      'no verdict': 'nothing about the application was proved — the harness ended this run before any claim was tested, so a catalog scores it blocked, not failed',
    };
    for (const [key, text] of Object.entries(meanings)) assert.ok(html.includes(text), `the meaning of ${key}`);
    for (const key of ['passed-with-issues', 'needs-review', 'human-confirmed', 'failed', 'quarantined', 'needs a human', 'recorded only', 'running']) {
      assert.match(html, new RegExp(`\n  '?${key.replace(/[-?]/g, (c) => '\\' + c)}'?: '`), `STATUS_MEANING has ${key}`);
    }
    // The helper, built through el() and never an HTML string, on all three rows.
    assert.match(html, /function meaningLine\(key, detail\)/);
    assert.match(html, /function runMeaningLine\(card, key\)/);
    assert.match(html, /isRunning \? null : runMeaningLine\(latest, why\)/, 'the run card');
    assert.match(html, /meaningLine\(entry\.status, entry\.reason\)/, 'the catalog case row');
    assert.match(html, /runMeaningLine\(card, cardMeaningKey\(card\)\)/, 'the history row');
    // A run with no verdict quotes the CLI's recorded reason after the words, verbatim.
    assert.match(html, /if \(card\.noVerdict && !isPassing\(card\.status\)\) return meaningLine\('no verdict', card\.noVerdict\)/);
    assert.match(html, /text: 'recorded reason: '/);
    // The machine status stays in the chip's title — the meaning line adds, never replaces.
    assert.match(html, /'status: ' \+ entry\.status/);
    assert.match(html, /chip\.title = status === 'error'/);
    // Full width of the grid row, so no column widens; theme ink only.
    assert.match(html, /\.meaning \{\n  grid-column: 1 \/ -1;/);
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
      assert.ok(html.includes(field), `the launcher lost "${field}"`);
    }
  });

  it('shows the claims at a glance above the checks table, and why a red run is red below it', () => {
    // claimsSummary: the test's polarity plus every assertion's
    // expected-vs-actual, rendered on expand ABOVE the step table — a reader
    // sees what was demanded and what the page really held before any
    // scrolling. whyBlock: the same pure verdict the HTML report leads with,
    // served alongside the bundle, rendered UNDER the table only when the run
    // is failed / error / dead-end.
    for (const marker of ['claimsSummary', 'whyBlock', 'Expected vs actual', 'Why it ',
      'polarityTag', 'expectedActualOf', '.claims-summary', '.why-block']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
    // The why block reads the server-computed verdict, cached beside the bundle.
    assert.match(html, /S\.verdicts\[/);
  });

  it('shows a catalog group\'s accuracy as agreement with the sheet, as a percent', () => {
    // accuracyLine mirrors groupAccuracy in ui/proofs.ts: verdicts matching
    // the sheet's recorded Actual Result (generatedBy.knownResult), rendered
    // on both catalog headers (the flows view and the history view), only on
    // catalogs, and only when the sheet recorded results to compare against.
    for (const marker of ['accuracyOf', 'accuracyLine', "'accuracy '", 'knownResult',
      'vs sheet', 'unscored', 'if (a.scored === 0) return null']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('offers Autoheal in front of the fold, wired to --repair', () => {
    // The launcher's checkbox, and the flag it becomes. Suites heal per case
    // through the same FlowRepairLoop `run --repair` uses.
    for (const marker of ['Autoheal enabled', 'M.autoheal', 'extras.repair = true']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('offers the backend toggle in front of the fold, with its database field', () => {
    // The launcher is hand-built, not generated from commands.ts, so a field
    // added to the spec does NOT appear here — this pins the control itself.
    for (const marker of [
      'Include backend steps',
      'M.backend',
      'extras.backend = M.backend === true',
      "extras['db-url'] = M.dbUrl.trim()",
      'Database URL',
    ]) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('gauges what the run charged the session, and never invents one', () => {
    // A token count says how much work the control plane did; this says what
    // the account was charged for it. Only shown when a session-billed
    // provider actually ran the flow — an API-key run has no session to
    // gauge, and a zero would read as "it was free" rather than "the
    // question does not apply".
    for (const marker of ['latest.session', 'session.costUsd.toFixed(2)', "' session'", 'served from cache']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('lets a workflow step open in place, showing what the agent did', () => {
    for (const marker of ['agent action', 'agentActionLog', 'The goal the agent was given']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('renders whole — a stray backtick truncates the page and takes the launcher with it', () => {
    // Measured 2026-08-25: one backtick inside a comment closed the template
    // literal this whole page lives in. It still typechecked, still served,
    // and silently lost every control below the break — the launcher included.
    // The last thing the page defines is the guard.
    assert.ok(html.includes('function renderWowUi'.replace('function ', '')) || html.length > 200_000);
    assert.ok(html.trimEnd().endsWith('</html>'), 'the document must close');
    assert.ok(html.includes('Start verification'), 'the launcher must survive to the end');
  });

  it('remembers context documents with a repository, and accepts PowerPoint', () => {
    for (const marker of ['Remember document…', "'context-doc': [doc.path]", '.pptx']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('carries the proved-? flow: chips, the review block, and the ruling endpoint', () => {
    for (const marker of ['proved-?', 'reviewBlock', 'effStatus', "'/review'",
      'Confirm proved', 'Confirm failed', 'needs-review']) {
      assert.ok(html.includes(marker), `the page lost "${marker}"`);
    }
  });

  it('opens the launcher inline in the page flow, never as an overlay', () => {
    // The start form is an expandable section directly under the header: the
    // same fields, the same POST payloads, but the runs it is about to add to
    // stay visible behind it. Collapsing resets the same state the old
    // modal's close did, so reopening always starts clean.
    assert.ok(html.includes("id: 'launcher'"), 'the inline host is missing');
    assert.ok(html.includes('toggleLauncher'), 'the start button must toggle the section');
    assert.ok(html.includes('closeLauncher'), 'collapsing must reset the form state');
    assert.doesNotMatch(html, /openStartModal/);
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

  it('keeps a still for every step by default, on every command that offers the choice', () => {
    // A filmed run under `auto` keeps a still only where a step FAILED, so the
    // evidence for everything that passed is a video frame someone has to
    // scrub to. The panel is where a run is read afterwards, and a
    // full-resolution still per step is what a reader opens.
    for (const spec of COMMANDS) {
      const stills = spec.fields.find((f) => f.name === 'screenshots');
      if (stills === undefined) continue;
      assert.equal(stills.default, 'all', `${spec.id} offers Stills and must default to all`);
      assert.ok(stills.choices?.includes('auto'), `${spec.id} still offers auto`);
    }
    // The form renders from the spec, so the default is what a submission
    // carries — and it reaches the run as an ordinary flag.
    assert.deepEqual(buildArgv(commandById('run')!, { flow: 'x.flow.json', screenshots: 'all' }), [
      'run', 'x.flow.json', '--screenshots', 'all',
    ]);
    // The launcher starts there too, on both pages (one shared script).
    assert.match(html, /screenshots: 'all'/);
    // …and `auto` is still expressible: it is sent as NOTHING, because the
    // run's own fallback is exactly what auto means.
    assert.match(html, /if \(M\.screenshots !== 'auto'\) extras\.screenshots = M\.screenshots;/);
  });

  it('asks for every account the catalog signs in as, and will not start until it has them', () => {
    // The gap this closes: the launcher had ONE credentials box, so a catalog
    // whose rows change hands — the manager submits, the HRBP approves — had
    // nowhere to give the second account. The run learned about it by refusing
    // rows minutes in, with a browser already open.
    assert.match(html, /function personaBlock\(M\)/);
    assert.match(html, /function personasUnanswered\(M\)/);
    assert.match(html, /function personaValues\(M\)/);

    // Rendered from what the CLI wrote into the claims file. The panel does
    // not re-read the sheet, and does not predict which rows will be refused.
    assert.match(html, /M\.claims && M\.claims\.personas/);
    assert.match(html, /case\(s\) sign in as this account/);

    // A password box, and handlers that update in place — a re-render on a
    // keystroke takes the caret out of the field being typed in.
    assert.match(html, /type: 'password', value: got\.password/);
    assert.match(html, /got\.password = e\.target\.value; syncSubmit\(\);/);
    assert.match(html, /got\.email = e\.target\.value; syncSubmit\(\);/);

    // Blocking, both ways in: the Start button and the one-press path.
    assert.match(html, /account\(s\) still need an email and a password/);
    assert.match(html, /countApproved\(M\) > 0 && personasUnanswered\(M\) === 0\) submitLauncher\(\);/);

    // Sent on the run as the field the command already declares — a secret, so
    // it rides the env overlay and never becomes argv.
    assert.match(html, /values\.personas = accounts;/);
    assert.ok(COMMANDS.find((c) => c.id === 'catalog-run')?.fields.some((f) => f.name === 'personas' && f.type === 'secret'));

    // In memory for as long as the launcher is open, and nowhere else. A
    // secret is not a view preference.
    assert.match(html, /personaCreds: \{\}/);
    assert.doesNotMatch(html, /localStorage[^\n]*personaCreds|personaCreds[^\n]*localStorage/);
  });

  it('offers an address it has run before, and asks for the password anyway', () => {
    // The half that is friction is the address: it does not change between
    // runs, and the person retyping it is the one who typed it yesterday. The
    // half that must never be remembered is the password — a store holding
    // both would be a credential on disk that can sign in on its own.
    assert.match(html, /function loadPersonaAccounts\(\)/);
    assert.match(html, /api\('\/api\/persona-accounts'\)/);
    // Loaded where the launcher loads its data, beside the documents fetch —
    // never on a poll: it changes only when a run starts.
    assert.match(html, /\n  loadDocuments\(\);\n  loadPersonaAccounts\(\);/);
    assert.match(html, /personaAccounts: \{\}/);

    // Nothing remembered for an account is exactly the box it had before.
    assert.match(html, /function accountPicker\(need, got\)/);
    assert.match(html, /if \(known\.length === 0\) return typed;/);

    // Something remembered is a list of them, most recent preselected.
    assert.match(html, /var known = rememberedAccounts\(need\.label\);/);
    assert.match(html, /if \(!got\.custom && \(got\.email \|\| ''\) === ''\) got\.email = known\[0\]\.email;/);
    assert.match(html, /text: 'Another account…'/);

    // Revealed in place. Re-rendering the form to show a field would rebuild
    // the control being used and take the caret with it.
    assert.match(html, /typed\.style\.display = got\.custom \? 'block' : 'none';/);
    const picker = /function accountPicker\(need, got\) \{[\s\S]*?\n\}/.exec(html)?.[0] ?? '';
    assert.ok(picker !== '', 'the picker is in the page');
    assert.doesNotMatch(picker, /renderLauncher\(/, 'a handler here syncs, it does not re-render');
    assert.ok(picker.includes('syncSubmit();'));

    // The password half is untouched: no memory, no offer, always typed, and
    // Start still blocked until it is there.
    assert.doesNotMatch(picker, /password/);
    assert.match(html, /type: 'password', value: got\.password/);
    assert.match(html, /account\(s\) still need an email and a password/);
    // …and the copy says so, because something IS written to disk now.
    assert.match(html, /is written nowhere, and never reaches the command line/);
  });

  it('names no account in code: labels come from the claims file, addresses from the store', () => {
    // The universal rule (`tests/no-hardcode.test.ts`) exempts this module
    // from its scan because it is an inline HTML/JS bundle, so the page string
    // is checked here instead: a persona label may be discussed in a comment
    // — that is history — and may never be a literal the page steers on or
    // shows. Comments stripped, nothing may be left.
    const code = html.replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert.doesNotMatch(code, /_ACCOUNT/);
  });

  it('remembers repositories under Machinery, and any run can select one', () => {
    // Saving is memory, not an upload: the Machinery view scans through the
    // whitelisted `context add` (never a shell string), and the launch modal
    // offers the saved repos in a dropdown on every run type. If any of these
    // strings vanish, either the way in or the way to use it is gone.
    assert.ok(html.includes("'Repositories'"));
    assert.match(html, /post\('context-add'/);
    assert.ok(html.includes('Ground in a saved repository'));
    assert.ok(html.includes('extras.repo'));
    // Add Context points at the new home rather than duplicating the scan.
    assert.ok(html.includes('Machinery › Repositories'));
  });

  it('labels backend steps as backend, and the mirror cannot drift', () => {
    // The client is a template string and cannot import BACKEND_TIER_ACTIONS,
    // so it carries a mirror — and this test pins every member of the real
    // set against the page, which is what makes the mirror safe to have.
    assert.ok(html.includes("text: 'backend'"));
    for (const action of BACKEND_TIER_ACTIONS) {
      assert.ok(html.includes(`${action}: 1`), `BACKEND_ACTIONS mirror is missing ${action}`);
    }
  });

  it('offers every format the extractor can actually read', () => {
    // A picker that accepts a .docx the extractor refuses is a picker that
    // produces an error after the upload rather than before it.
    for (const extension of SUPPORTED_EXTENSIONS) {
      assert.ok(html.includes(extension), `the file picker does not offer ${extension}`);
    }
  });

  it('takes a sequence diagram as an image, for catalogs only', async () => {
    // The catalog picker offers the image containers the transcriber reads;
    // the context picker must NOT, because the server refuses an image there
    // (context documents reach the extractor directly, which reads no pixels).
    assert.ok(html.includes('CATALOG_ACCEPT'), 'the catalog picker lost its own accept list');
    assert.match(html, /CATALOG_ACCEPT = DOCUMENT_ACCEPT \+ ',\.png,\.jpg,\.jpeg,\.webp,\.svg'/);
    assert.doesNotMatch(html, /DOCUMENT_ACCEPT = [^;]*\.png/);
    // And the server-side half of the same rule (thrown before any write):
    await assert.rejects(
      saveDocument({ kind: 'context', name: 'flow.png', contentBase64: Buffer.from('x').toString('base64') }),
      /only be a catalog/,
    );
    // An image name survives upload with its extension intact — including
    // .svg, which must NEVER fall back to .txt: a rendered diagram read as
    // raw XML prose produced 30 ungated "claims" live. It routes through the
    // same transcription gate as a picture instead.
    assert.equal(safeName('whiteboard photo.PNG'), 'whiteboard-photo.png');
    assert.equal(safeName('seqimg.svg'), 'seqimg.svg');
    await assert.rejects(
      saveDocument({ kind: 'context', name: 'seqimg.svg', contentBase64: Buffer.from('<svg/>').toString('base64') }),
      /only be a catalog/,
    );
  });

  it('shows the claims before anything is proved', () => {
    assert.ok(html.includes('lists what it claims'));
    assert.match(html, /untick anything you do not want before it costs tokens and a browser/);
    // The two halves of the gate, both declared in the whitelist.
    assert.ok(html.includes("'catalog-claims'"));
    assert.ok(html.includes("'catalog-run'"));
  });

  it('lets the gate correct a guessed lane, and keeps the correction', () => {
    // A sequence diagram's planes decide which claims are checkable, and the
    // diagram never says which host is the API — so the gate renders the
    // participant table with the guesses flagged, and an edit recomputes the
    // claim list live rather than sending someone into the JSON by hand.
    assert.ok(html.includes('Lanes — who is who in this diagram'));
    assert.ok(html.includes('guessed — confirm'));
    assert.ok(html.includes('recomputeLanes'));
    // The mirrored observability rule — the client cannot import
    // isObservable, so this pins the copy against silent deletion. The rule
    // itself is tested where it lives, in tests/sequence.test.ts.
    assert.ok(html.includes("plane === 'user' || plane === 'page'"));
    // The write-back must carry the edited participant table, or the lane
    // corrections the gate just collected are silently discarded.
    assert.ok(html.includes('sequence: M.claims.sequence'));
  });

  it('shows a database check and asserted traffic as step evidence', () => {
    assert.ok(html.includes('Database check'));
    assert.ok(html.includes('Traffic this step asserted'));
    assert.ok(html.includes('Forbidden calls it observed'));
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

  it('streams a running job’s console into its own card, not a side pane', () => {
    // The SSE and replay wiring is unchanged server-side; only the pane moved.
    // One way output is shown: an expandable section under the card it
    // explains — live while the job runs, the finished-run section afterwards.
    assert.ok(html.includes('streamJob'), 'the live stream feeds the card section');
    assert.ok(html.includes("'/events'"), 'the SSE endpoint is still how lines arrive');
    assert.ok(html.includes('outputSection'), 'the one shared output section');
    assert.doesNotMatch(html, /jobPanel|openJobDrawer/, 'the sidebar output pane must stay gone');
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

  it('reads command output rather than dumping it: classified rows, case groups, filters, copy raw', () => {
    // The lines are the CLI's, untouched in substance (src/ui/console-lines.ts);
    // the page only decides how each is laid out and which filter keeps it.
    // Both surfaces render output through this one view, so what is pinned
    // here holds on Ledger too (tests/ledger-ui.test.ts pins it there).
    assert.equal((html.match(/function consoleView\(/g) ?? []).length, 1, 'one console view');
    assert.equal((html.match(/function classifyLine\(/g) ?? []).length, 1, 'the classifier ships once');
    assert.doesNotMatch(html, /function outLine\(/, 'the old one-div-per-line renderer is gone');
    // Live lines and the replay both go through the view, in place, never via render().
    assert.match(html, /out\.view\.append\(line\);\s*out\.view\.follow\(\);/);
    assert.match(html, /out\.view\.reset\(S\.jobLines\[jobId\] \|\| \[\]\)/);
    // Stderr is a muted gutter marker, never colour alone; steps carry their glyph.
    assert.match(html, /'printed on stderr'/);
    assert.match(html, /\.con-row\.step-pass \.con-g \{ color: var\(--ok\)/);
    assert.match(html, /\.con-row\.step-fail \.con-g \{ color: var\(--bad\)/);
    // A case's lines sit under one sticky label instead of a repeated prefix.
    assert.match(html, /\.con-case \{[^}]*position: sticky/);
    // ask:/response: fold behind a toggle; a refusal's bullets are a list.
    assert.match(html, /function conFold\(row, c\)/);
    assert.match(html, /function conBullet\(row, c\)/);
    assert.match(html, /el\('ul', \{ class: 'con-bullets' \}\)/);
    // An indented line rides with the row above it: a refusal item's wrapped
    // rest, a step's detail, an agent turn's note (2026-09-04 shapes).
    assert.match(html, /function conDetail\(row, c\)/);
    assert.match(html, /if \(c\.hang && last && \(last\.list \|\| last\.c\.kind === 'step-pass'/);
    assert.match(html, /class: 'con-key', text: c\.label/, 'the two-column summary keeps its key');
    // The filter row, its persistence guarded, and the raw copy that ignores it.
    for (const label of ["'All'", "'Steps'", "'Model calls'", "'Problems'"]) assert.ok(html.includes(label), label);
    assert.match(html, /try \{\s*var v = localStorage\.getItem\('wow-console-filter'\)/);
    assert.match(html, /try \{ localStorage\.setItem\('wow-console-filter', v\); \} catch/);
    assert.match(html, /text: 'Copy raw'/);
    assert.match(html, /placeholder: 'find in output'/);
    // The filter hides rows; an author display must not beat the UA's [hidden].
    assert.match(html, /\.con-row\[hidden\], \.con-group\[hidden\], \.con-fold\[hidden\] \{ display: none; \}/);
    // A filter change re-reads mounted views in place — never render().
    assert.match(html, /function conApplyAll\(\) \{ conViews\(\)\.forEach\(function \(v\) \{ v\.apply\(\); \}\); \}/);
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
    // tqdm's readout, mirrored from formatProgressReadout in ui/jobs.ts —
    // the client is a template string and cannot import it, so this pins the
    // mirror against silent deletion.
    assert.ok(html.includes('tqdmReadout'), 'the tqdm readout mirror is missing');
    assert.ok(html.includes("'s/it'") && html.includes("'it/s'"), 'the rate must flip units as tqdm does');
  });

  it('builds every node through el(), never from an HTML string', () => {
    // `textContent` cannot be talked into executing a selector, a model's
    // reasoning, or application text quoted back by a failing step. Unlike the
    // command panel there is no `trustedHtml` escape hatch here at all.
    assert.doesNotMatch(html, /innerHTML|trustedHtml|insertAdjacentHTML|document\.write/);
  });

  it('asks how far the test should reach, with real radios', () => {
    // A select hides the option not chosen; these two change what the run
    // DOES, so both stay on screen with their consequence beside them.
    assert.match(html, /How far should it reach\?/);
    assert.match(html, /type: 'radio', name: 'launch-scope'/);
    assert.match(html, /End-to-end/);
  });
});

describe('the command whitelist', () => {
  const claims = commandById('catalog-claims')!;
  const run = commandById('catalog-run')!;

  it('declares the scope the launcher offers, so the server accepts it', () => {
    // The radio in the Describe launcher sends `scope`, and a value this file
    // does not declare is refused by the server — commands.ts is the single
    // declaration the form and the argv builder share.
    for (const id of ['go', 'author']) {
      const field = commandById(id)!.fields.find((one) => one.name === 'scope');
      assert.ok(field, `${id} must declare scope`);
      assert.deepEqual(field?.choices, ['unit', 'e2e']);
      assert.equal(field?.default, 'unit');
    }
    assert.deepEqual(
      buildArgv(commandById('go')!, { target: 'check the journey', scope: 'e2e' }),
      ['go', 'check the journey', '--scope', 'e2e'],
    );
  });

  it('offers the backend toggle on every command that authors a test', () => {
    for (const id of ['go', 'generate', 'author', 'catalog-run']) {
      const spec = commandById(id)!;
      const toggle = spec.fields.find((one) => one.name === 'backend');
      assert.ok(toggle, `${id} must offer the backend toggle`);
      assert.equal(toggle?.type, 'boolean');
      assert.equal(toggle?.default, false, 'opt-in in the panel — most runs have no database');
      assert.equal(toggle?.offFlag, 'no-backend');
      const dbUrl = spec.fields.find((one) => one.name === 'db-url');
      assert.equal(dbUrl?.type, 'secret', 'a connection string never becomes argv');
      assert.equal(dbUrl?.envVar, 'WOWLIDATOR_DB_URL');
      assert.deepEqual(dbUrl?.requiredWhen, { field: 'backend', equals: true });
    }
  });

  it('states the backend choice in both directions, and only when it was stated', () => {
    const go = commandById('go')!;
    // Off: said out loud, because the CLI's own default is ON and every
    // existing script must keep behaving as it did.
    assert.deepEqual(buildArgv(go, { target: 'a claim', backend: false }), ['go', 'a claim', '--no-backend']);
    assert.deepEqual(buildArgv(go, { target: 'a claim', backend: true }), ['go', 'a claim', '--backend']);
    // Absent means "not stated" — never a silent turn-off for callers that
    // predate the toggle.
    assert.deepEqual(buildArgv(go, { target: 'a claim' }), ['go', 'a claim']);
  });

  it('asks for the database URL exactly when backend testing is on', () => {
    const go = commandById('go')!;
    // The point of asking here: a DB claim with no database is a case that
    // dies ten minutes in.
    assert.throws(
      () => buildEnvOverlay(go, { target: 'a claim', backend: true }),
      (error: unknown) => error instanceof UiCommandError && /required when "backend" is on/.test(error.message),
    );
    assert.deepEqual(
      buildEnvOverlay(go, { target: 'a claim', backend: true, 'db-url': 'postgres://u@localhost:5432/app' }),
      { WOWLIDATOR_DB_URL: 'postgres://u@localhost:5432/app' },
    );
    // Off, it is nobody's business.
    assert.deepEqual(buildEnvOverlay(go, { target: 'a claim', backend: false }), {});
    // And a secret never reaches argv, whatever the submission says.
    assert.equal(
      buildArgv(go, { target: 'a claim', backend: true, 'db-url': 'postgres://u@h/db' }).join(' ').includes('postgres://'),
      false,
    );
  });

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

  it('expands a repeatable positional into consecutive argv entries', () => {
    // wowUI's group-level "Rerun all" / "Heal all" send the flow list this
    // way: one job, one browser slot, instead of a refused job per case.
    const spec = commandById('run')!;
    assert.deepEqual(
      buildArgv(spec, { flow: ['a.flow.json', 'b.flow.json'] }),
      ['run', 'a.flow.json', 'b.flow.json'],
    );
    // A lone string is the single-flow form every existing caller sends — it
    // is still exactly one argv entry, so nothing can be smuggled through it.
    assert.deepEqual(buildArgv(spec, { flow: 'a.flow.json' }), ['run', 'a.flow.json']);
    // Flags still follow every positional.
    assert.deepEqual(
      buildArgv(spec, { flow: ['a.flow.json', 'b.flow.json'], repair: true }),
      ['run', 'a.flow.json', 'b.flow.json', '--repair'],
    );
  });

  it('refuses an empty or missing repeatable positional the command requires', () => {
    const spec = commandById('run')!;
    assert.throws(() => buildArgv(spec, {}), UiCommandError);
    assert.throws(() => buildArgv(spec, { flow: [] }), UiCommandError);
    assert.throws(() => buildArgv(spec, { flow: ['a.flow.json', ''] }), UiCommandError);
    assert.throws(() => buildArgv(spec, { flow: ['a.flow.json', 'b\0.json'] }), UiCommandError);
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
    // A hidden run: parked under archived/ by the panel's Hide button. Still
    // on disk, still a valid bundle — and it must never be listed.
    await mkdir(join(dir, 'archived'), { recursive: true });
    await writeFile(
      join(dir, 'archived', 'hidden.json'),
      JSON.stringify(bundle({ runId: 'run-hidden', finishedAt: '2026-08-10T09:00:00.000Z' })),
      'utf8',
    );
  });

  after(() => clearProofCache());

  it('lists every bundle, newest first, and counts what it skipped', async () => {
    const index = await readProofIndex(dir);
    assert.deepEqual(index.cards.map((c) => c.runId), ['run-2', 'run-1', 'run-3']);
    assert.equal(index.skipped, 2, 'the two non-bundles');
  });

  it('never lists a run hidden under archived/ — cleared from screen, kept on disk', async () => {
    const index = await readProofIndex(dir);
    assert.ok(!index.cards.some((c) => c.runId === 'run-hidden'));
    // And a renamed run carries its original name for the flow-file lookup.
    const renamed = toCard(
      { ...JSON.parse(JSON.stringify(bundle({ runId: 'r' }))), name: 'My better name', renamedFrom: 'PL_01_01 old name' },
      '/x/r.json',
    );
    assert.equal(renamed.name, 'My better name');
    assert.equal(renamed.renamedFrom, 'PL_01_01 old name');
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

  it('projects why a run delivered no verdict, by the CLI\'s own rule, never a second one', () => {
    // A pass carries no such reason.
    assert.equal(toCard(bundle(), '/tmp/run-1.json').noVerdict, null);
    // A failed run where a claim was actually contradicted: a verdict exists.
    const contradicted = bundle();
    contradicted.status = 'failed';
    contradicted.steps[1] = { ...contradicted.steps[1]!, action: 'expectVisible', status: 'failed', error: 'expected the banner, the page holds nothing' };
    assert.equal(toCard(contradicted, '/tmp/run-2.json').noVerdict, null);
    // The session guard fired: every broken step is `error`, and the reason
    // it recorded — the sign-in page, the session never established — is what
    // the row quotes under the chip. Same words as `harnessOnly`, same function.
    const stranded = bundle();
    stranded.status = 'failed';
    stranded.steps[1] = {
      ...stranded.steps[1]!,
      status: 'error',
      error: 'the run is on the sign-in page (http://localhost:3000/en/login) after asking for /en — the session is not established, so nothing after this point can say anything about the feature under test.\n  Every later step would be asserted against the login screen.',
    };
    const card = toCard(stranded, '/tmp/run-3.json');
    assert.ok(card.noVerdict !== null);
    assert.match(card.noVerdict!, /^runtime error — the harness ended this case, not the application: the run is on the sign-in page/);
    assert.match(card.noVerdict!, /the session is not established/);
    assert.doesNotMatch(card.noVerdict!, /\n/, 'first line only — it goes on one row');
    // A run that never got going at all.
    const dead = bundle();
    dead.status = 'failed';
    dead.steps = [];
    dead.error = 'could not attach to Chrome at http://localhost:9222\nstart it with: npm run chrome';
    assert.equal(toCard(dead, '/tmp/run-4.json').noVerdict, 'could not attach to Chrome at http://localhost:9222');
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

describe('a case\'s recorded reason, read out of the command\'s own output', () => {
  it('keeps the reason from the BLOCKED and no-verdict lines and nothing else', () => {
    assert.equal(caseReasonOf('BLOCKED PL_02_03 — authoring refused (attempt 2): the flow proves nothing about its claim'), 'authoring refused (attempt 2): the flow proves nothing about its claim');
    assert.equal(caseReasonOf('  ! no verdict: runtime error — the harness ended this case, not the application: the session is not established'), 'runtime error — the harness ended this case, not the application: the session is not established');
    assert.equal(caseReasonOf('case "PL_02_03" blocked'), null);
    assert.equal(caseReasonOf('  ✓ 3/7 the sign-in button works'), null);
    assert.equal(caseReasonOf('BLOCKED x — '), null);
    assert.equal(caseReasonOf('BLOCKED x — ' + 'y'.repeat(400))!.length, 300, 'one row, capped');
  });
});

describe('live progress, read out of the command\'s own output', () => {
  const fresh = (): JobProgress =>
    ({ done: 0, total: null, etaMs: null, percent: null, phase: null, rateMsPerStep: null, lastStepMs: 0, startedMs: null });

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
    // The run slows down; the estimate follows \u2014 smoothly. tqdm's EMA
    // (smoothing 0.3): 0.3\u00b73000 + 0.7\u00b71000 = 1600ms/step, \u00d7 8 left = 12.8s,
    // between the old pace (8s) and what a raw average would claim (16s).
    applyProgressLine(progress, '\u2713 [1] click (1ms)', 4_000);
    assert.equal(Math.round(progress.rateMsPerStep!), 1_600);
    assert.equal(progress.etaMs, 12_800);
  });

  it('moves the estimate smoothly when the pace bursts, never instantly', () => {
    // tqdm's smoothing is the reference: after two 5s steps, a 100ms step must
    // pull the ETA down without collapsing it to the last dt alone.
    const progress = fresh();
    applyProgressLine(progress, '  plan       10 step(s)', 0);
    applyProgressLine(progress, '\u2713 [0] click (1ms)', 5_000);
    applyProgressLine(progress, '\u2713 [1] click (1ms)', 10_000);
    assert.equal(progress.etaMs, 40_000, 'steady 5s/step, 8 left');
    applyProgressLine(progress, '\u2713 [2] click (1ms)', 10_100);
    // 0.3\u00b7100 + 0.7\u00b75000 = 3530ms/step \u2014 far above the burst's own 100ms,
    // well below the old pace: the average is moving, not teleporting.
    assert.equal(Math.round(progress.rateMsPerStep!), 3_530);
    assert.equal(progress.etaMs, 24_710);
    applyProgressLine(progress, '\u2713 [3] click (1ms)', 10_200);
    assert.equal(Math.round(progress.rateMsPerStep!), 2_501, 'each fast step pulls it further down');
    assert.equal(progress.etaMs, 15_006);
  });

  it('prints tqdm\u2019s readout: done/total [elapsed<remaining, rate]', () => {
    const progress = fresh();
    applyProgressLine(progress, '  plan       10 step(s)', 0);
    applyProgressLine(progress, '\u2713 [0] click (1ms)', 4_000);
    assert.equal(formatProgressReadout(progress, 4_000), '1/10 [00:04<00:36, 4.0s/it]');
  });

  it('flips the rate to it/s past one step per second, as tqdm does', () => {
    const progress = fresh();
    applyProgressLine(progress, '  plan       10 step(s)', 0);
    applyProgressLine(progress, '\u2713 [0] click (1ms)', 400);
    assert.equal(formatProgressReadout(progress, 400), '1/10 [00:00<00:04, 2.5it/s]');
  });

  it('renders no readout before there is anything to read', () => {
    // Half a readout \u2014 a total with no pace, a pace with no total \u2014 would look
    // like a measurement that was never made.
    const noTotal = fresh();
    applyProgressLine(noTotal, '\u2713 [0] visitLink (900ms)', 900);
    assert.equal(formatProgressReadout(noTotal, 900), null, 'a crawl has no denominator');
    const noStep = fresh();
    applyProgressLine(noStep, '  plan       10 step(s)', 0);
    assert.equal(formatProgressReadout(noStep, 500), null, 'no step has finished');
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
      governor: { provider: 'groq', modelId: 'llama-3.1-8b-instant' },
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

  it('carries a local port as a base URL, and only for local', () => {
    // Two rerise servers differ by port alone, so the port is the whole of
    // the choice — and it is a property of a server on this machine, so a
    // port sent with any other provider is dropped rather than recorded.
    const models = new ModelSelection();
    models.select('generator', 'local', 'default_model', 8081);
    assert.deepEqual(models.envOverlay(), {
      WOWLIDATOR_GENERATOR_PROVIDER: 'local',
      WOWLIDATOR_GENERATOR_MODEL: 'default_model',
      WOWLIDATOR_GENERATOR_BASE_URL: 'http://localhost:8081/v1',
    });
    const view = models.describeRoles(config).find((r) => r.role === 'generator')!;
    assert.equal(view.port, 8081);

    models.select('healer', 'groq', 'llama-3.3-70b-versatile', 8081);
    assert.equal(models.envOverlay()['WOWLIDATOR_HEALER_BASE_URL'], undefined);
    assert.equal(models.describeRoles(config).find((r) => r.role === 'healer')!.port, null);

    assert.throws(() => models.select('agent', 'local', 'default_model', 70000), ModelSelectionError);
    assert.throws(() => models.select('agent', 'local', 'default_model', 0.5), ModelSelectionError);
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

describe('grouping runs by the pass that authored them', () => {
  /** A card as the list serves it, with just the fields grouping reads. */
  function card(
    runId: string,
    at: string,
    provenance: { generatedAt: string; source?: string; scenario?: string; caseTitle?: string; rationale?: string; knownResult?: 'passed' | 'failed' } | null,
    status: 'passed' | 'failed' | 'dead-end' | 'error' | 'needs-review' = 'passed',
    polarity?: 'positive' | 'negative',
    name = runId,
  ) {
    return toCard(
      bundle({
        runId,
        name,
        status,
        startedAt: at,
        finishedAt: at,
        ...(polarity === undefined ? {} : { polarity, polaritySource: 'stated' }),
        ...(provenance === null
          ? {}
          : {
              generatedBy: {
                model: 'stub',
                generatedAt: provenance.generatedAt,
                sourceUrl: 'http://localhost:3000/en/login',
                kind: 'catalog',
                rationale: provenance.rationale ?? '6 cases',
                ...(provenance.source === undefined ? {} : { source: provenance.source }),
                ...(provenance.scenario === undefined ? {} : { scenario: provenance.scenario }),
                ...(provenance.caseTitle === undefined ? {} : { caseTitle: provenance.caseTitle }),
                ...(provenance.knownResult === undefined ? {} : { knownResult: provenance.knownResult }),
              },
            }),
      }),
      `/tmp/${runId}.json`,
    );
  }

  it('puts one authoring pass in one group, titled by its document', () => {
    const groups = groupRuns([
      card('a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
      card('b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
      card('c', '2026-08-19T03:42:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.title, 'probation.xlsx');
    assert.equal(groups[0]?.runs.length, 3);
    assert.equal(groups[0]?.total, 3);
  });

  // The requirement in one test: the same catalog run twice is two groups, not
  // one group of twelve with a pass rate averaged over two different builds.
  it('makes a NEW group when the same catalog is run again', () => {
    const groups = groupRuns([
      card('later-a', '2026-08-19T05:00:00.000Z', { generatedAt: 'T2', source: 'probation.xlsx' }),
      card('later-b', '2026-08-19T05:01:00.000Z', { generatedAt: 'T2', source: 'probation.xlsx' }),
      card('early-a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
      card('early-b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
    ]);
    assert.equal(groups.length, 2, 'same document, two passes, two groups');
    assert.deepEqual(
      groups.map((g) => g.title),
      ['probation.xlsx', 'probation.xlsx'],
    );
    // Newest group first, and each one holds only its own pass.
    assert.deepEqual(groups[0]?.runs.map((r) => r.runId), ['later-a', 'later-b']);
    assert.deepEqual(groups[1]?.runs.map((r) => r.runId), ['early-a', 'early-b']);
  });

  it('tallies each group on its own runs', () => {
    const groups = groupRuns([
      card('a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', source: 'x.xlsx' }, 'passed'),
      card('b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', source: 'x.xlsx' }, 'failed'),
    ]);
    assert.equal(groups[0]?.passed, 1);
    assert.equal(groups[0]?.failed, 1);
  });

  it('leaves a run nobody authored as a group of its own', () => {
    const groups = groupRuns([
      card('hand-written', '2026-08-19T03:40:00.000Z', null),
      card('also-hand', '2026-08-19T03:41:00.000Z', null),
    ]);
    assert.equal(groups.length, 2, 'unrelated runs must not imply a relationship');
    assert.equal(groups[0]?.kind, 'run');
  });

  it('falls back to the page URL when no document was recorded', () => {
    const groups = groupRuns([card('a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1' })]);
    assert.equal(groups[0]?.title, 'http://localhost:3000/en/login');
  });

  it('spans the group from its earliest start to its latest finish', () => {
    const groups = groupRuns([
      card('a', '2026-08-19T03:45:00.000Z', { generatedAt: 'T1', source: 'x.xlsx' }),
      card('b', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', source: 'x.xlsx' }),
    ]);
    assert.equal(groups[0]?.startedAt, '2026-08-19T03:40:00.000Z');
    assert.equal(groups[0]?.finishedAt, '2026-08-19T03:45:00.000Z');
  });

  it('is empty for an empty list', () => {
    assert.deepEqual(groupRuns([]), []);
  });

  // A catalog's roll-up is asked for as a share, not a count: "proved 60%,
  // test-failed 20%, system error 20%" of a five-case sheet. Two families
  // (2026-08-27): a dead-end joins failed as testFailed — the subject missed
  // the case's expectation either way — and error stands alone as
  // systemError, the harness breaking with no verdict delivered.
  it('tallies each verdict family as a count and a percentage of the group', () => {
    const groups = groupRuns([
      card('a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1' }, 'passed'),
      card('b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1' }, 'passed'),
      card('c', '2026-08-19T03:42:00.000Z', { generatedAt: 'T1' }, 'passed'),
      card('d', '2026-08-19T03:43:00.000Z', { generatedAt: 'T1' }, 'dead-end'),
      card('e', '2026-08-19T03:44:00.000Z', { generatedAt: 'T1' }, 'error'),
    ]);
    const tally = groups[0]!.tally;
    assert.deepEqual(tally.passed, { count: 3, percent: 60 });
    assert.deepEqual(tally.testFailed, { count: 1, percent: 20 }, 'the dead-end reads as the subject failing the case');
    assert.deepEqual(tally.systemError, { count: 1, percent: 20 });
    assert.deepEqual(tally.needsReview, { count: 0, percent: 0 });
    assert.deepEqual(tallyVerdicts([]).passed, { count: 0, percent: 0 }, 'an empty list divides by nothing');
  });

  // Accuracy is agreement with the sheet's own recorded results: the Actual
  // Result column is a person's verdict on each case, and the score is how
  // often wowlidator's verdict matches it — passed where they saw Passed,
  // failed where they saw Failed. Positive/Negative cannot score a run (a
  // negative case is still expected to pass, by the app refusing), a
  // dead-end/error run delivered no verdict and agrees with nothing, and a
  // row the sheet left unverdicted is disclosed as unscored, never invented
  // into either side.
  it('scores accuracy as agreement with the sheet\'s recorded Actual Result', () => {
    const groups = groupRuns([
      // Human saw Passed, run passed — agreement.
      card('a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', knownResult: 'passed' }, 'passed'),
      // Human filed a bug, run failed — agreement: the known defect was found.
      card('b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', knownResult: 'failed' }, 'failed'),
      // Human saw Passed, run failed — a false alarm, disagreement.
      card('c', '2026-08-19T03:42:00.000Z', { generatedAt: 'T1', knownResult: 'passed' }, 'failed'),
      // Human saw Passed, run errored — no verdict delivered, disagreement.
      card('d', '2026-08-19T03:43:00.000Z', { generatedAt: 'T1', knownResult: 'passed' }, 'error'),
      // The sheet recorded nothing (Cancelled/Pending/blank) — unscored.
      card('e', '2026-08-19T03:44:00.000Z', { generatedAt: 'T1' }, 'passed'),
    ]);
    assert.deepEqual(groups[0]!.accuracy, { agreed: 2, scored: 4, unscored: 1, percent: 50 });
    assert.deepEqual(
      groupAccuracy([]),
      { agreed: 0, scored: 0, unscored: 0, percent: 0 },
      'an empty list divides by nothing',
    );
  });

  // A case retried until it passed is one case of the sheet, not several
  // chances at agreement. The list arrives newest-first, so the latest
  // verdict is the one scored.
  it('collapses retries to the latest verdict when scoring accuracy', () => {
    const groups = groupRuns([
      card('retry-2', '2026-08-19T04:00:00.000Z', { generatedAt: 'T1', knownResult: 'passed' }, 'passed', undefined, 'PL_01_01 menu'),
      card('retry-1', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', knownResult: 'passed' }, 'failed', undefined, 'PL_01_01 menu'),
      card('b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', knownResult: 'failed' }, 'passed'),
    ]);
    // Two distinct cases: the retried one agrees on its latest run; the case
    // whose known bug the run missed does not.
    assert.deepEqual(groups[0]!.accuracy, { agreed: 1, scored: 2, unscored: 0, percent: 50 });
  });

  // Bundles written before the stamp existed still carry the case id in
  // their name, and a sheet numbers cases inside their scenario — so the
  // id less its last segment is the scenario, and the rest is the title.
  it('infers the scenario and title from the case id when no stamp was recorded', () => {
    assert.equal(inferredScenario('PL_02_03 ตรวจสอบความถูกต้อง Create Benefit Plan'), 'PL_02');
    assert.equal(inferredCaseTitle('PL_02_03 ตรวจสอบความถูกต้อง Create Benefit Plan'), 'ตรวจสอบความถูกต้อง Create Benefit Plan');
    assert.equal(inferredScenario('TC-12-4 Reject leave'), 'TC-12');
    assert.equal(inferredScenario('DB_07 seed restore'), 'DB');
    assert.equal(inferredScenario('Leave Request Submission Flow'), null, 'a plain name is not an id');
    assert.equal(inferredScenario('PL_02_03'), 'PL_02');
    assert.equal(inferredCaseTitle('PL_02_03'), null);
    const groups = groupRuns([
      card('PL_02_03 Create', '2026-08-19T03:42:00.000Z', { generatedAt: 'T1' }),
      card('PL_02_01 Menu', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1' }),
      card('PL_01_01 Visible', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1' }),
    ]);
    assert.deepEqual(groups[0]!.scenarios.map((s) => s.title), ['PL_02', 'PL_01']);
    assert.equal(groups[0]!.scenarios[0]!.runs.length, 2);
  });

  it('groups a catalog\'s runs by the sheet scenario, in sheet order, and keeps the case title', () => {
    const groups = groupRuns([
      card('c3', '2026-08-19T03:42:00.000Z', { generatedAt: 'T1', scenario: 'S2 Leave approval', caseTitle: 'Reject leave' }, 'failed'),
      card('c2', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', scenario: 'S1 Login', caseTitle: 'Wrong password' }),
      card('c1', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', scenario: 'S1 Login', caseTitle: 'Valid login' }),
      card('c0', '2026-08-19T03:39:00.000Z', { generatedAt: 'T1' }),
    ]);
    const scenarios = groups[0]!.scenarios;
    assert.deepEqual(scenarios.map((s) => s.title), ['S2 Leave approval', 'S1 Login', 'ungrouped']);
    assert.equal(scenarios[1]!.runs.length, 2);
    assert.deepEqual(scenarios[1]!.tally.passed, { count: 2, percent: 100 });
    assert.deepEqual(scenarios[0]!.tally.testFailed, { count: 1, percent: 100 });
    assert.equal(scenarios[1]!.runs[0]!.generatedBy?.caseTitle, 'Wrong password');
    assert.equal(scenarios[0]!.id, `${groups[0]!.id}|S2 Leave approval`, 'stable across polls');
    assert.equal(groupScenarios('g', []).length, 0);
  });

  // A re-run or a repair used to land under "Authored flows", because the
  // bundle it produced carried no provenance — `wowlidator run x.flow.json`
  // knows nothing about the catalog that wrote the file. `Flow.authoredBy`
  // puts it in the file, so the later run reports the same pass and comes
  // back to the group it belongs to.
  it('keeps a re-run of an authored case in its original group', () => {
    const groups = groupRuns([
      card('rerun-of-a', '2026-08-19T06:00:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
      card('a', '2026-08-19T03:40:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
      card('b', '2026-08-19T03:41:00.000Z', { generatedAt: 'T1', source: 'probation.xlsx' }),
    ]);
    assert.equal(groups.length, 1, 'the re-run belongs to the pass that authored the flow');
    assert.equal(groups[0]?.runs.length, 3);
    assert.equal(groups[0]?.title, 'probation.xlsx');
  });
});

describe('credentials in the panel', () => {
  const CONSUMERS = ['go', 'run', 'generate', 'author', 'catalog-run', 'watch'];

  it('every command that consumes --as offers the field; claims-reading does not', () => {
    for (const id of CONSUMERS) {
      const spec = commandById(id);
      assert.ok(spec?.fields.some((f) => f.name === 'as' && f.type === 'secret'), id);
    }
    // Claims extraction opens no browser and signs nothing in — a control
    // there would be a lie.
    assert.ok(!commandById('catalog-claims')?.fields.some((f) => f.name === 'as'));
  });

  // The rule the whole design hangs on: argv is what ps prints, what the
  // panel displays, and what the job record keeps — the password may appear
  // in none of them.
  it('a secret never becomes argv, and rides the env overlay instead', () => {
    const spec = commandById('run')!;
    const values = { flow: '/tmp/x.flow.json', as: 'employee@cnext.test:pw:with:colons' };
    const argv = buildArgv(spec, values);
    assert.ok(!argv.some((a) => a.includes('pw:with:colons')), 'password must not reach argv');
    assert.ok(!argv.includes('--as'));
    assert.deepEqual(buildEnvOverlay(spec, values), {
      WOWLIDATOR_AS: 'employee@cnext.test:pw:with:colons',
    });
  });

  it('rejects a malformed pair with a sentence, before any run starts', () => {
    const spec = commandById('run')!;
    for (const bad of ['no-colon', ':pw', 'email:']) {
      assert.throws(
        () => buildEnvOverlay(spec, { flow: '/tmp/x.flow.json', as: bad }),
        /email:password/,
        bad,
      );
    }
  });

  it('an empty value contributes nothing, so the panel environment falls through', () => {
    const spec = commandById('run')!;
    assert.deepEqual(buildEnvOverlay(spec, { flow: '/tmp/x.flow.json', as: '' }), {});
    assert.deepEqual(buildEnvOverlay(spec, { flow: '/tmp/x.flow.json' }), {});
  });

  it('both surfaces render a secret as a password input', async () => {
    const { renderWowUi } = await import('../src/ui/wow-ui-html.js');
    const { renderLedger } = await import('../src/ui/ledger-html.js');
    assert.match(renderWowUi(), /type: 'password'/);
    assert.match(renderLedger(), /'secret' \? 'password'/);
  });
});

describe('a local role addressed by port', () => {
  it('reads WOWLIDATOR_<ROLE>_BASE_URL per role, falling back to LOCAL_LLM_BASE_URL', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({
      WOWLIDATOR_GENERATOR_PROVIDER: 'local',
      WOWLIDATOR_GENERATOR_BASE_URL: 'http://localhost:8081/v1/',
      WOWLIDATOR_HEALER_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: 'http://localhost:8080/v1',
      GROQ_API_KEY: 'k',
      GOOGLE_GENERATIVE_AI_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.roles.generator.baseUrl, 'http://localhost:8081/v1');
    assert.equal(cfg.roles.healer.baseUrl, 'http://localhost:8080/v1');
    // A base URL on a provider that has no local server is not carried.
    assert.equal(cfg.roles.agent.baseUrl, undefined);
  });

  it('hands the role its own base URL when the model is built', async () => {
    const { createModelForRole } = await import('../src/providers/llm-factory.js');
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({
      WOWLIDATOR_DATA_PROVIDER: 'local',
      WOWLIDATOR_DATA_BASE_URL: 'http://localhost:9001/v1',
      GROQ_API_KEY: 'k',
      GOOGLE_GENERATIVE_AI_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    const seen: unknown[] = [];
    createModelForRole('data', cfg, 0, {
      ...Object.fromEntries(
        ['google', 'groq', 'openrouter', 'emmiedev', 'zai', 'deepseek', 'local'].map((p) => [
          p,
          (_k: string, _m: string, o?: { baseUrl?: string | undefined }) => {
            seen.push(o?.baseUrl);
            return {} as never;
          },
        ]),
      ),
    } as never);
    assert.deepEqual(seen, ['http://localhost:9001/v1']);
  });

  it('persists the port beside the provider and comments it out on a move away', async () => {
    const { persistRoleModel } = await import('../src/ui/models.js');
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'wow-env-'));
    const env = join(dir, '.env');
    await persistRoleModel('generator', { provider: 'local', modelId: 'default_model', baseUrl: 'http://localhost:8081/v1' }, env);
    let text = await readFile(env, 'utf8');
    assert.match(text, /^WOWLIDATOR_GENERATOR_BASE_URL=http:\/\/localhost:8081\/v1$/m);
    await persistRoleModel('generator', { provider: 'groq', modelId: 'llama-3.3-70b-versatile' }, env);
    text = await readFile(env, 'utf8');
    assert.match(text, /^# WOWLIDATOR_GENERATOR_BASE_URL=/m);
    assert.doesNotMatch(text, /^WOWLIDATOR_GENERATOR_BASE_URL=/m);
  });
});
