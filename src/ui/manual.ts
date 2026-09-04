/**
 * The manual, as it appears on the Manual tab.
 *
 * Kept here rather than in a README the UI links out to, because the point of
 * the panel is that everything is in one place: someone who has never used
 * wowlidator should be able to open it and find out what a policy tier is without
 * leaving the page or being handed a 38 000-word file.
 *
 * This is trusted content — ours, static, no interpolation — which is why the
 * page is allowed to set it with `innerHTML`. Nothing user- or model-supplied
 * goes anywhere near it.
 */

export interface ManualSection {
  id: string;
  title: string;
  html: string;
}

export const MANUAL: readonly ManualSection[] = [
  {
    id: 'start',
    title: 'Start here',
    html: `
      <p class="lead">wowlidator writes, runs and repairs UI tests. This panel is the whole thing —
      every command, every option, the reports it produces and the history of what it found.</p>

      <h3>The shortest possible run</h3>
      <ol class="steps">
        <li><b>Start the app you want to test</b> — whatever <code>npm run dev</code> means in that project.</li>
        <li><b>Open <span class="tab-ref">Go</span></b> and paste the page's URL, e.g. <code>http://localhost:3000</code>.</li>
        <li><b>Press Run.</b> wowlidator starts Chrome itself, reads the page, writes tests for it, runs them, and shows you a report.</li>
      </ol>
      <p>You do not need to start Chrome. You do not need to write a test first. Both are handled.</p>

      <h3>What the Go box accepts</h3>
      <table class="ref">
        <tr><th>What you type</th><th>What happens</th></tr>
        <tr><td><code>examples/login.flow.json</code></td><td>Runs that existing test.</td></tr>
        <tr><td><code>http://localhost:3000/orders</code></td><td>Reads that page, writes tests for it, runs them.</td></tr>
        <tr><td><code>check the filter clears when I press Reset</code></td><td>Writes one test for that behaviour and runs it. Fill in <b>Page to write the test against</b> as well — without a page, every selector is a guess.</td></tr>
      </table>

      <h3>Before anything that uses a model</h3>
      <p>Writing tests needs an API key; running an existing test does not.
      Open <span class="tab-ref">Doctor</span> — it makes one real call per role and tells you
      exactly which key is missing and where to get it. Keys live in <code>.env</code> at the
      project root.</p>
    `,
  },

  {
    id: 'idea',
    title: 'The idea in one minute',
    html: `
      <p>Ordinary UI tests break for a boring reason: someone renamed a button. wowlidator splits the
      work in two so that costs almost nothing.</p>
      <ul class="split">
        <li><b>The execution plane</b> is plain Playwright with short timeouts. It does the clicking.
        It costs nothing per action and never calls a model.</li>
        <li><b>The control plane</b> is a model, and it is only consulted where determinism has run
        out — after a selector has already failed, or when there is no test yet to run.</li>
      </ul>

      <h3>What happens when a step fails</h3>
      <p>Six rungs, cheapest first. Only the last one costs anything:</p>
      <ol class="ladder">
        <li><b>fast</b> — your selector, 2 seconds. Free.</li>
        <li><b>case</b> — the same selector with the name matched case-insensitively. Free.
        Chrome and Playwright disagree about CSS <code>text-transform</code> in accessible names, and this is that disagreement.</li>
        <li><b>dialog</b> — is a cookie banner or modal in the way? Dismiss it and retry the original selector. Free.</li>
        <li><b>cache</b> — a repair from a previous run. Free. A cached selector that fails is deleted, not retried.</li>
        <li><b>backend</b> — did a request the page made already fail with a 5xx or a dead connection?
        Then stop. Free. Repairing a selector onto the error banner the app rendered instead would be worse than failing.</li>
        <li><b>heal</b> — capture the accessibility tree, ask the model for a replacement, verify it resolves to exactly one element, cache it. This is the only rung that spends tokens.</li>
      </ol>
      <p>Most runs never reach rung 6. A run whose heal count is climbing is telling you the
      tests are drifting away from the app — which is why the report shows that number.</p>
    `,
  },

  {
    id: 'tabs',
    title: 'What each tab does',
    html: `
      <table class="ref">
        <tr><th>Tab</th><th>Use it when</th></tr>
        <tr><td><span class="tab-ref">Go</span></td><td>You do not want to think about which command. One box, start to report.</td></tr>
        <tr><td><span class="tab-ref">Run a flow</span></td><td>You have a <code>.flow.json</code> and want to execute it. Turn on <b>Repair on failure</b> to have the model rewrite it around a break and retry.</td></tr>
        <tr><td><span class="tab-ref">Generate tests</span></td><td>You have a page and no tests. Reads the accessibility tree and writes a suite.</td></tr>
        <tr><td><span class="tab-ref">Author one test</span></td><td>You know the one behaviour you want checked. Describe it in a sentence.</td></tr>
        <tr><td><span class="tab-ref">Crawl</span></td><td>You want breadth, not depth: follow every link on a page, check a real page comes back, check you can get home again.</td></tr>
        <tr><td><span class="tab-ref">Watch</span></td><td>You want a test re-run on an interval and to hear about it only when the result <em>changes</em>.</td></tr>
        <tr><td><span class="tab-ref">Doctor</span></td><td>Something model-backed is failing, or you have just set up keys. Model ids drift faster than anything else here.</td></tr>
        <tr><td><span class="tab-ref">Project index</span></td><td>You want generation to know what the repo contains — routes, components, existing tests, API endpoints. No model call is made to build it.</td></tr>
        <tr><td><span class="tab-ref">Healed selectors</span></td><td>You want to see, or drop, the repairs the healer has cached.</td></tr>
        <tr><td><span class="tab-ref">Flows</span></td><td>Browse and edit every <code>.flow.json</code> wowlidator can see. Edit, save, run — without leaving the page.</td></tr>
        <tr><td><span class="tab-ref">Reports</span></td><td>Every report ever rendered, newest first, opened inline.</td></tr>
        <tr><td><span class="tab-ref">History</span></td><td>Is this newly broken, or has it been broken for a week? Those need opposite responses.</td></tr>
        <tr><td><span class="tab-ref">Runs</span></td><td>The output of everything this panel has started since it was launched.</td></tr>
      </table>
    `,
  },

  {
    id: 'policy',
    title: 'How much is it allowed to do? (mutation policy)',
    html: `
      <p>Every command that writes tests has a policy, and it is enforced structurally — the
      model is not merely asked nicely, the option list it can choose from is filtered before the
      prompt is built and every step it produces is re-checked on the way out.</p>
      <table class="ref">
        <tr><th>Policy</th><th>May do</th><th>Never</th></tr>
        <tr><td><code>read-only</code></td><td>Navigate, read, assert.</td><td>Submit anything at all.</td></tr>
        <tr><td><code>forms</code></td><td>Submit <b>empty or invalid</b> input and assert the validation error appears.</td><td>Submit valid data that would write.</td></tr>
        <tr><td><code>mutations</code><br><span class="muted">the default</span></td><td>Fill, submit, create and update — like a human tester.</td><td>Delete, purchase, bulk operations.</td></tr>
      </table>
      <p><code>mutations</code> is the default: a human QA fills forms with real data and submits
      them, and the suite does the same out of the box. Narrow to <code>forms</code> for
      validation-only negative testing, or <code>read-only</code> where even an invalid submit is
      unwelcome. <b>Nothing deletes at any tier</b>, including <code>mutations</code>.</p>
    `,
  },

  {
    id: 'flow',
    title: 'The flow file',
    html: `
      <p>A test is a JSON file. That is the whole format:</p>
<pre><code>{
  "name": "orders list filters",
  "baseUrl": "http://localhost:3000",
  "setup":  [ { "action": "goto", "url": "/login" } ],
  "steps":  [
    { "action": "click",         "selector": "role=button[name=\\"Due soon\\" i]",
      "intent": "Filter the list down to what is due this week." },
    { "action": "expectVisible", "selector": "role=table" },
    { "action": "expectCount",   "selector": "role=row", "count": 4 }
  ],
  "teardown": [ { "action": "clearStorage" } ]
}</code></pre>
      <ul>
        <li><b><code>setup</code> runs first</b>, and a failure there short-circuits the body — a test whose preconditions did not hold cannot produce a meaningful result.</li>
        <li><b><code>teardown</code> always runs</b>, and never masks a failure in the body.</li>
        <li><b><code>intent</code> is what the report shows</b> under each step, in your own words. Write it as "what this step checks".</li>
      </ul>

      <h3>Actions</h3>
      <table class="ref small">
        <tr><th>Group</th><th>Actions</th></tr>
        <tr><td>Navigation</td><td><code>goto</code> <code>back</code> <code>forward</code> <code>scrollTo</code></td></tr>
        <tr><td>Interaction</td><td><code>click</code> <code>fill</code> <code>waitFor</code> <code>press</code></td></tr>
        <tr><td>Assertions</td><td><code>expectVisible</code> <code>expectHidden</code> <code>expectText</code> <code>expectValue</code> <code>expectCount</code> <code>expectUrl</code> <code>expectEnabled</code> <code>expectDisabled</code> <code>expectAttribute</code> <code>expectScrollable</code> <code>expectNotScrollable</code></td></tr>
        <tr><td>Keyboard &amp; focus</td><td><code>expectFocused</code> <code>expectTabOrder</code> — focus order is the one accessibility property that cannot be read from a static tree; it only exists while tabbing.</td></tr>
        <tr><td>Modals</td><td><code>expectModal</code> <code>closeModal</code></td></tr>
        <tr><td>Data-driven</td><td><code>fillEach</code> (one field, several values, an assertion after each — every case runs even after one fails) · <code>fillRetry</code> (regenerate the value and retry when the app says "already exists")</td></tr>
        <tr><td>Backend</td><td><code>request</code> <code>expectStatus</code> <code>expectJson</code> <code>expectHeader</code> — sent through the browser's session, so a flow logs in through the real UI once and then talks HTTP as that user</td></tr>
        <tr><td>Composition</td><td><code>use</code> (splice in another flow) · <code>when</code> (branch on <code>visible</code>/<code>hidden</code>/<code>enabled</code>/<code>disabled</code>)</td></tr>
        <tr><td>Visual</td><td><code>snapshot</code> — a missing baseline is created and passes, saying so</td></tr>
        <tr><td>State</td><td><code>setLocalStorage</code> <code>clearStorage</code></td></tr>
        <tr><td>Agentic</td><td><code>workflow</code> — hand the browser to the model until a stated goal is met. For unknown interstitials, not for ordinary steps.</td></tr>
      </table>

      <h3>Selectors</h3>
      <p>Prefer Playwright's role engine — it is what the healer, the coverage report and the
      generator all speak:</p>
<pre><code>role=button[name="Save"]        an accessible role and name
role=button[name="Save" i]      …matched case-insensitively (safer; see below)
role=textbox[name="Email"]
text=Save                       last resort
#save-button                    CSS works, but coverage cannot attribute it</code></pre>
      <p>The <code>i</code> flag is worth defaulting to. Chrome applies CSS
      <code>text-transform</code> when it computes an accessible name and Playwright does not, so a
      button styled uppercase is captured as <code>"SAVE"</code> and matched against
      <code>"Save"</code>. Without the flag such a selector is unresolvable by construction — not
      flaky, never resolvable. Everything wowlidator generates carries the flag already.</p>

      <h3>A test with no assertion is refused</h3>
      <p>A case that only clicks and navigates passes whether or not the feature works, which is
      worse than no test because it displaces manual checking. The generator will not emit one,
      and says so on the Runs output rather than dropping it silently.</p>
    `,
  },

  {
    id: 'report',
    title: 'Reading a report',
    html: `
      <p>Three layers, strictly ordered, and every sentence in the first is derived from the
      evidence in the others rather than written by hand.</p>
      <ol class="steps">
        <li><b>Verdict</b> — what broke, which side of the system it belongs to, and whether it is new.</li>
        <li><b>Timeline</b> — the steps in your own words, failures already expanded.</li>
        <li><b>Diagnostics</b> — which rung each step resolved on, token spend, coverage, trend. Collapsed by default.</li>
      </ol>

      <h3>The recording</h3>
      <p><b>A run is filmed only when something goes wrong</b>, and the recording runs from the
      start of the flow to the step that failed — the state leading up to a failure is most of
      what makes it diagnosable, and film of what happened afterwards only buries it. A run that
      passes keeps no recording, which is what makes filming affordable by default: the reports
      that carry one are the ones you were going to open anyway. If the recording cannot be cut
      to the failure it is dropped rather than handed over whole, so a video that is there is
      always a video that ends where it says it does.</p>
      <p>The recording sits above the timeline, with <b>a pointer drawn into the page</b> so you
      can see the clicks. A still cannot show a click — it shows the page before one and the page
      after one, and those are the same picture whether the click landed on the right control, the
      wrong one, or nothing at all. Every step body has a <b>play from here</b> that jumps the
      video to that step, and the caption in the corner names the step as it runs, so the file is
      still an account of a test after you have pulled it out and attached it to a bug.</p>
      <p>It cannot be reconstructed after the fact — re-running to have a look changes the very
      timing that caused it. So the run is recorded as it happens, and the cost is paid in the
      size of the report file, which the Diagnostics section states outright.</p>
      <p><b>Recording needs a browser context wowlidator creates, so a filmed run does not inherit
      cookies from a browser you signed into by hand.</b> If a run depends on that session, set
      <b>Record the run</b> to <em>off</em> in the advanced options — which also puts stills back
      on every step.</p>

      <h3>The filmstrip</h3>
      <p>When a run is filmed, stills are kept for <b>failures only</b>: the recording already
      covers every other step, and what a still adds over a frame is resolution — which matters at
      exactly the place someone zooms in to read an error message. Set <b>Stills</b> to
      <em>all</em> to get both.</p>
      <p>With recording off, stills are the whole story and <b>every step leaves one, not just the
      one that broke</b> — a failure screenshot shows you the wreckage, and the frame <em>before</em>
      it is usually where the wrong thing actually happened. Scrub the strip, find where the page
      stopped looking right, click that frame to jump to its step. The failing frame is outlined in
      red.</p>

      <h3>Badges you will see</h3>
      <table class="ref">
        <tr><td><b>healed</b></td><td>The original selector failed and the model repaired it. The test is drifting from the app — worth a look even though it passed.</td></tr>
        <tr><td><b>cached</b></td><td>Resolved by a repair from an earlier run. Free.</td></tr>
        <tr><td><b>dialog</b></td><td>Something was blocking the page; it was dismissed and the original selector retried. Recorded as a real usability defect, because it blocks people too.</td></tr>
        <tr><td><b>backend</b></td><td>A request the page made failed. No amount of selector work fixes this, and it routes to a different team.</td></tr>
        <tr><td><b>agent</b></td><td>The model drove the browser for that step.</td></tr>
      </table>
      <p>An ordinary step that resolved first time carries no badge — labelling every one of them
      would bury the ones that need attention.</p>

      <p><b>Frontend and backend are counted separately.</b> A failed <code>expectVisible</code> and a
      failed <code>expectStatus</code> go to different people, so the summary splits them rather than
      averaging them into one number nobody can act on.</p>

      <p>Reports are self-contained — screenshots and styles are embedded — so one opens off a
      USB stick or out of an email attachment. Credentials are redacted before anything is
      written: a payload that could not be inspected is replaced by its size and type, because
      "we did not recognise the format" is not evidence it holds no secret.</p>
    `,
  },

  {
    id: 'history',
    title: 'History, flakiness and quarantine',
    html: `
      <p>A single run answers "did this pass". It cannot answer <em>is this newly broken, or has it
      been broken for a week</em> — and those demand opposite responses. The
      <span class="tab-ref">History</span> tab is the append-only log that answers the second question.</p>
      <table class="ref">
        <tr><td><code>first-run</code></td><td>Nothing to compare against yet.</td></tr>
        <tr><td><code>newly-broken</code></td><td>It passed last time. This is the one to act on today.</td></tr>
        <tr><td><code>still-broken</code></td><td>Already known. Not new information.</td></tr>
        <tr><td><code>newly-fixed</code></td><td>Someone fixed it.</td></tr>
        <tr><td><code>stable</code></td><td>Passing, consistently.</td></tr>
        <tr><td><code>flaky</code></td><td>Two or more flips in the last twenty runs. <b>This outranks pass and fail</b> — a test that alternates is untrustworthy whichever side the coin landed on this time.</td></tr>
      </table>
      <p><b>Quarantine never engages by itself.</b> Silently downgrading a flaky failure is exactly
      how a suite ends up green while checking nothing, so it is opt-in per run, a consistently
      failing test is refused entry with a reason, and leaving needs five consecutive real passes.</p>

      <h3>A heal that hides a race</h3>
      <p>After a successful repair, wowlidator re-checks the <em>original</em> selector. If it resolves now,
      it was never broken — it was slower than the 2-second budget, and the heal would have hidden
      a timing bug permanently. That is reported as a defect rather than a quiet success.</p>
    `,
  },

  {
    id: 'models',
    title: 'Models, keys and cost',
    html: `
      <p>Four roles, each pointed at whichever provider suits its shape. Any role can point at any
      provider; nothing is hard-wired.</p>
      <table class="ref">
        <tr><th>Role</th><th>Called when</th><th>Why that tier</th></tr>
        <tr><td><code>healer</code></td><td>A selector has already failed.</td><td>Small and latency-sensitive.</td></tr>
        <tr><td><code>generator</code></td><td>You ask for tests to be written, or turn on repair.</td><td>Largest prompt in the system — a whole accessibility tree.</td></tr>
        <tr><td><code>agent</code></td><td>A <code>workflow</code> step runs.</td><td>General reasoning, one decision per turn.</td></tr>
        <tr><td><code>data</code></td><td>A <code>fillRetry</code> whose kind is <code>custom</code>.</td><td>Small and rare — the other five kinds never touch a model at all.</td></tr>
      </table>

      <p><b>Model ids are the most fragile thing in the system.</b> They drift far faster than the
      code does. <span class="tab-ref">Doctor</span> makes a real one-token call per role and is the
      only way to know a default still resolves — it proves the id is real, though not that the
      model can emit schema-constrained JSON, which is what every role actually needs.</p>

      <p>Set keys and routing in <code>.env</code> at the project root:</p>
<pre><code>GOOGLE_GENERATIVE_AI_API_KEY=…
GROQ_API_KEY=…
OPENROUTER_API_KEY=…

WOWLIDATOR_GENERATOR_PROVIDER=google
WOWLIDATOR_GENERATOR_MODEL=gemini-3.6-flash</code></pre>
      <p>A run with healing and the agent turned off, against an existing flow, needs no key at all.</p>
    `,
  },

  {
    id: 'files',
    title: 'Where everything lands',
    html: `
      <table class="ref">
        <tr><td><b>Reports</b></td><td>The report directory, one folder per page. Configurable with <code>WOWLIDATOR_REPORT_DIR</code>.</td></tr>
        <tr><td><b>Proof bundles</b></td><td>The proof directory — the machine-readable record every report is rendered from.</td></tr>
        <tr><td><b>Generated flows</b></td><td>Beside the report they produce, so it is obvious which made which.</td></tr>
        <tr><td><b>Repair attempts</b></td><td><code>&lt;name&gt;.attempt-N.flow.json</code> next to the original, plus a <code>.patch</code> explaining the change. <b>Your file is never overwritten.</b></td></tr>
        <tr><td><b>Healed selectors</b></td><td>One JSON cache. Environment-specific; commit it deliberately or leave it local.</td></tr>
        <tr><td><b>Run history</b></td><td><code>.wowlidator/history.jsonl</code>, appended to, never rewritten.</td></tr>
        <tr><td><b>Project index</b></td><td><code>.wowlidator/context-graph.json</code>, rebuilt when file sizes or timestamps change.</td></tr>
      </table>
      <p>The exact paths this install is using are listed at the bottom of the sidebar.</p>
    `,
  },

  {
    id: 'trouble',
    title: 'When something goes wrong',
    html: `
      <table class="ref">
        <tr><th>What you see</th><th>What it means</th></tr>
        <tr><td>"could not attach to a browser"</td><td>No driveable Chrome. wowlidator normally starts one itself — unless <b>Do not start or repair Chrome</b> is ticked in the advanced options.</td></tr>
        <tr><td>"Browser context management is not supported"</td><td>A Chrome that has been running too long. It answers status checks perfectly and refuses real work. wowlidator detects this and recycles it — but only on its own profile; someone else's browser is reported and left alone.</td></tr>
        <tr><td>"cannot reach http://…"</td><td>The app under test is not up. Use <b>Wait for URL</b> in the advanced options if it is still booting.</td></tr>
        <tr><td>"the … role has no API key configured"</td><td>Open <span class="tab-ref">Doctor</span>; it names the environment variable and links to where the key comes from.</td></tr>
        <tr><td>A step fails but the selector looks right</td><td>Check the report's <b>backend</b> section first. If the data behind the control never arrived, the control never rendered, and the selector was never the problem. Then play the recording from the failing step and watch the step or two before it: the page is usually already in the wrong state before anything goes red.</td></tr>
        <tr><td>Every case fails on the same control</td><td>Likely an accessible-name case mismatch. Add the <code>i</code> flag: <code>role=button[name="Save" i]</code>.</td></tr>
        <tr><td>"is still running and also needs the browser"</td><td>Two runs cannot share one Chrome without interleaving their clicks. Stop the first from the <span class="tab-ref">Runs</span> tab.</td></tr>
        <tr><td>A generated test does nothing useful</td><td>Try <b>Open menus first</b> — controls one click behind a disclosure are invisible to a single reading of the page. Or narrow it with <b>Focus</b>.</td></tr>
      </table>
    `,
  },

  {
    id: 'cli',
    title: 'The same thing on the command line',
    html: `
      <p>This panel starts the ordinary CLI and streams its output — nothing here is exclusive to
      the UI. The command line for every run is printed above its output so you can copy it into a
      script or a CI job.</p>
<pre><code>npm run ui                                  # this panel
npm run cli -- go http://localhost:3000      # what the Go tab runs
npm run cli -- run examples/login.flow.json --repair
npm run cli -- generate &lt;url&gt; --run --policy forms
npm run cli -- author "…" --url &lt;url&gt; --run
npm run cli -- crawl &lt;url&gt; --follow-buttons
npm run cli -- watch flow.json --every 15m --notify ./notify.sh
npm run cli -- context build --openapi ./openapi.yaml
npm run cli -- doctor
npm run cli -- mcp                           # serve to developer tooling over stdio</code></pre>
      <h3>Exit codes, for CI</h3>
      <table class="ref">
        <tr><td><code>0</code></td><td>Ran to completion, everything passed.</td></tr>
        <tr><td><code>1</code></td><td>Ran to completion, something failed. A real result — open a ticket.</td></tr>
        <tr><td><code>2</code></td><td>Could not start: bad arguments, missing file, invalid flow.</td></tr>
        <tr><td><code>3</code></td><td>Could not start: no browser, undriveable Chrome, missing key. Fix the runner, not the app.</td></tr>
      </table>
    `,
  },
];
