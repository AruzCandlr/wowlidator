/**
 * The command surface, declared once.
 *
 * This file is the single place the browser's forms and the server's argv
 * construction agree on what wowlidator can be asked to do. The UI renders its
 * controls *from* these specs and the server validates every submission
 * *against* them, so the two cannot drift: a flag the UI offers is a flag the
 * server accepts, and a flag missing here is offered by neither.
 *
 * That matters more than tidiness. The server turns a form submission into an
 * argv array for `spawn` — never a shell string — and this whitelist is what
 * decides which entries may appear in it. A free-form "extra arguments" box
 * would undo the whole arrangement, which is why there isn't one.
 *
 * Adding a CLI flag to the UI is one entry here and nothing else.
 */

import { DEFAULT_MAX_REPAIR_ATTEMPTS } from '../repair/flow-repair-loop.js';

export type FieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'enum';

export interface Field {
  /** Wire name. For a flag this is the flag itself, minus the leading `--`. */
  name: string;
  label: string;
  type: FieldType;
  /** Positional index (1-based, after the command words). Omit for flags. */
  positional?: number;
  choices?: readonly string[];
  placeholder?: string;
  /** One line, shown under the control. This is the manual, inline. */
  help: string;
  default?: string | number | boolean;
  required?: boolean;
  /** Hidden behind "more options" — real, but not the common case. */
  advanced?: boolean;
  min?: number;
  /**
   * May be given more than once, becoming `--name a --name b`. The UI sends an
   * array; anything else is rejected, so a repeatable flag cannot be smuggled
   * in as one string containing a separator.
   */
  repeatable?: boolean;
}

export interface CommandSpec {
  id: string;
  /** The literal command words, e.g. ['cache', 'forget']. */
  argv: readonly string[];
  title: string;
  /** One sentence: what this command is for. */
  blurb: string;
  /**
   * Needs a driveable Chrome. Browser commands are serialised against each
   * other — two runs sharing one CDP endpoint interleave their clicks, and the
   * resulting report describes neither.
   */
  browser: boolean;
  /** Runs until stopped. The UI shows Stop instead of waiting for an exit. */
  longRunning?: boolean;
  /** Needs a model key. The UI says so up front rather than 30s in. */
  roles?: readonly string[];
  /**
   * Flags this command always carries, with no control of its own.
   *
   * This is how one CLI command backs two panel actions that differ only by a
   * mode switch — `catalog --claims-only` and `catalog --claims <file>` are the
   * two halves of one gate, not two things a person should have to know to
   * combine. They stay in the whitelist rather than being appended by the
   * server, so what runs is still exactly what this file declares.
   */
  fixedFlags?: readonly string[];
  fields: readonly Field[];
}

/** Options every browser-touching command shares. Kept in the advanced drawer. */
const COMMON_BROWSER_FIELDS: readonly Field[] = [
  {
    name: 'video',
    label: 'Record the run',
    type: 'enum',
    choices: ['on', 'always', 'off'],
    default: 'on',
    help: 'Films the run with a pointer drawn into the page, so the report shows what the test did rather than only what the page looked like — a still cannot show a click, only the page either side of one. Each step in the report can be played from. Recording needs a browser context wowlidator creates, so a filmed run does NOT inherit the attached browser\'s cookies: turn it off for a run that depends on a session you signed into by hand. A crawl is never filmed — it drives a borrowed page rather than a recording context — so this has no effect there.',
    advanced: true,
  },
  {
    name: 'screenshots',
    label: 'Stills',
    type: 'enum',
    choices: ['auto', 'all', 'on-event', 'on-failure', 'off'],
    default: 'auto',
    help: 'auto follows the recording: failures only while filming, since the video already covers every other step, and every step when filming is off. all adds a filmstrip alongside the video — the same run twice, at several times the report size, worth it only when you need full-resolution frames. Each capture costs 50–150ms, plus the settle below.',
    advanced: true,
  },
  {
    name: 'capture-delay',
    label: 'Settle before each screenshot (ms)',
    type: 'number',
    default: 250,
    min: 0,
    help: 'Navigation waits for domcontentloaded, which fires before a client-rendered app has drawn anything — capture on that event and the filmstrip is a reel of empty shells for steps that passed. Raise it for a slow or heavily animated app; 0 captures as early as possible.',
    advanced: true,
  },
  {
    name: 'step-delay',
    label: 'Pause before each step (ms)',
    type: 'number',
    min: 0,
    help: 'Paces the run so a viewer can follow it. Left empty, the runner decides: 1.5s while recording the actual flow (video: always), instant otherwise.',
    advanced: true,
  },
  {
    name: 'no-reconstruct',
    label: 'Disable in-run step reconstruction',
    type: 'boolean',
    help: 'By default a failed step is rebuilt by the repair model against the live page and retried, up to 3 total tries, before being classified. Rescues are recorded and file a drift defect; assertions always keep their claim. Tick to classify on the first failure instead.',
    advanced: true,
  },
  {
    name: 'no-heal',
    label: 'Disable the JIT healer',
    type: 'boolean',
    help: 'Execution plane only. No model call is ever made to repair a selector.',
    advanced: true,
  },
  {
    name: 'no-agent',
    label: 'Disable the navigation agent',
    type: 'boolean',
    help: 'A `workflow` step fails instead of letting a model drive the browser.',
    advanced: true,
  },
  {
    name: 'no-network',
    label: 'Do not watch the page’s HTTP traffic',
    type: 'boolean',
    help: 'Observing costs no tokens and is what lets a failure say "the request behind this returned 500". Rarely worth turning off.',
    advanced: true,
  },
  {
    name: 'no-history',
    label: 'Do not record run history',
    type: 'boolean',
    help: 'Skips the append-only log that flake detection and newly-broken/still-broken trends read from.',
    advanced: true,
  },
  {
    name: 'quarantine-flaky',
    label: 'Quarantine known-flaky failures',
    type: 'boolean',
    help: 'Reports a flaky failure without counting it. Needs history; a consistently failing test is never quarantined.',
    advanced: true,
  },
  {
    name: 'update-baselines',
    label: 'Rewrite visual baselines',
    type: 'boolean',
    help: 'Overwrites the stored screenshots a `snapshot` step compares against instead of comparing to them.',
    advanced: true,
  },
  {
    name: 'headless',
    label: 'Headless Chrome',
    type: 'boolean',
    help: 'Launch without a window. Right on a CI runner, awkward on a desk — you cannot watch it work.',
    advanced: true,
  },
  {
    name: 'no-ensure-chrome',
    label: 'Do not start or repair Chrome',
    type: 'boolean',
    help: 'Use whatever browser is already on the CDP port, unchecked.',
    advanced: true,
  },
  {
    name: 'stop-chrome',
    label: 'Quit Chrome afterwards',
    type: 'boolean',
    help: 'Only ever stops a browser this run started. Someone else’s Chrome is left alone.',
    advanced: true,
  },
  {
    name: 'wait-for',
    label: 'Wait for URL',
    type: 'text',
    placeholder: 'http://localhost:3000',
    help: 'Block until this responds before starting — for a dev server that is still booting.',
    advanced: true,
  },
  {
    name: 'cdp',
    label: 'CDP endpoint',
    type: 'text',
    placeholder: 'http://localhost:9222',
    help: 'The debugging port of the Chrome to drive.',
    advanced: true,
  },
  {
    name: 'report',
    label: 'Report destination',
    type: 'text',
    placeholder: 'a file, a directory, or a {name}.html template',
    help: 'Where the HTML report lands. Placeholders: {runId} {name} {status} {date} {index} {kind} {group}.',
    advanced: true,
  },
  {
    name: 'no-report',
    label: 'Skip the HTML report',
    type: 'boolean',
    help: 'The proof bundle is still written; only the rendered report is skipped.',
    advanced: true,
  },
  {
    name: 'junit',
    label: 'JUnit XML path',
    type: 'text',
    placeholder: 'artifacts/junit.xml',
    help: 'Also write JUnit XML for a CI server to ingest.',
    advanced: true,
  },
  {
    name: 'ctrf',
    label: 'CTRF JSON path',
    type: 'text',
    placeholder: 'artifacts/ctrf.json',
    help: 'Also write CTRF JSON, with wowlidator’s own numbers under "extra".',
    advanced: true,
  },
];

const SCOPE_FIELD: Field = {
  name: 'scope',
  label: 'Test scope',
  type: 'enum',
  choices: ['unit', 'e2e'],
  default: 'unit',
  help: 'unit: prove one thing on the page given. e2e: the whole journey — reach the page as a user does, act, verify on the page that results. e2e is enforced: it reads the destination page too, and refuses a flow that never leaves the first one.',
};

const POLICY_FIELD: Field = {
  name: 'policy',
  label: 'Mutation policy',
  type: 'enum',
  choices: ['read-only', 'forms', 'mutations'],
  default: 'forms',
  help: 'read-only: never submits. forms: submits empty/invalid input to exercise validation. mutations: creates and updates. Never deletes, at any tier.',
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'go',
    argv: ['go'],
    title: 'Go',
    blurb: 'One box, start to report. What you type decides what happens.',
    browser: true,
    roles: ['generator'],
    fields: [
      {
        name: 'target',
        label: 'Flow file, URL, or a description of a test',
        type: 'text',
        positional: 1,
        required: true,
        placeholder: 'examples/login.flow.json  |  http://localhost:3000  |  "check pagination is disabled on one page"',
        help: 'A .json path runs that test. A URL generates and runs tests for that page. Anything else is a test to write — give it a page below.',
      },
      {
        name: 'url',
        label: 'Page to write the test against',
        type: 'text',
        placeholder: 'http://localhost:3000/some/page',
        help: 'Required only when the box above is a description. Without it every selector would be a guess.',
      },
      {
        name: 'repo',
        label: 'Saved repository',
        type: 'text',
        placeholder: 'slug or path from context add',
        help: 'Ground the written test in a saved repository’s indexed routes, endpoints and tables. Save one with "context add"; an unknown value fails loudly rather than authoring ungrounded.',
      },
      SCOPE_FIELD,
      POLICY_FIELD,
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  {
    id: 'run',
    argv: ['run'],
    title: 'Run a flow',
    blurb: 'Execute an existing .flow.json against the browser.',
    browser: true,
    fields: [
      {
        name: 'flow',
        label: 'Flow file',
        type: 'text',
        positional: 1,
        required: true,
        placeholder: 'examples/login.flow.json',
        help: 'Pick one from the Flows tab, or type a path.',
      },
      {
        name: 'repair',
        label: 'Repair on failure',
        type: 'boolean',
        help: 'On failure, ask the generator role to rewrite the flow around the break and retry. Never overwrites your file — each attempt lands as its own .attempt-N.flow.json plus a .patch explaining the change.',
      },
      {
        name: 'repair-attempts',
        label: 'Repair attempts',
        type: 'number',
        default: DEFAULT_MAX_REPAIR_ATTEMPTS,
        min: 1,
        help: 'Total runs including the first. Reports a dead end, not a crash, if every attempt still fails.',
      },
      {
        name: 'repair-investigate',
        label: 'Reinvestigate failures live',
        type: 'boolean',
        help: 'Before each fix, the agent goes back to the page and tries to reach the state the failed step needed — opening menus, waiting, scrolling — and the fix is proposed against the page it opened up. Acts on the application, so it is opt-in. Implies repair.',
      },
      {
        name: 'repair-regenerate',
        label: 'Regenerate from the failed step',
        type: 'boolean',
        help: 'Lets a fix rewrite the failed step and everything after it in the same section, for when the failure shows the rest of the flow was written against a page that does not exist. Steps before the failure are never touched. Implies repair.',
      },
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  {
    id: 'generate',
    argv: ['generate'],
    title: 'Generate tests',
    blurb: 'Read a page’s accessibility tree and write the tests for it.',
    browser: true,
    roles: ['generator'],
    fields: [
      {
        name: 'url',
        label: 'Page URL',
        type: 'text',
        positional: 1,
        placeholder: 'http://localhost:3000/some/page',
        help: 'The page to read. Not needed when "API tests from the spec" is on.',
      },
      {
        name: 'run',
        label: 'Run the generated cases immediately',
        type: 'boolean',
        default: true,
        help: 'Each case is written out as a standalone flow either way, so you can run it again later without regenerating.',
      },
      {
        name: 'focus',
        label: 'Focus',
        type: 'text',
        placeholder: 'the filter controls',
        help: 'Steer generation at one part of the page.',
      },
      {
        name: 'max-cases',
        label: 'Max cases',
        type: 'number',
        default: 6,
        min: 1,
        help: 'Cap on how many cases to write.',
      },
      POLICY_FIELD,
      {
        name: 'probe',
        label: 'Open menus first',
        type: 'boolean',
        help: 'Opens the page’s disclosures so controls that only exist after a click are visible. Clicks ARIA-marked disclosures only — never a plain button — and closes each one again.',
      },
      {
        name: 'no-agent-capture',
        label: 'Capture without the agent pilot',
        type: 'boolean',
        help: 'By default an agent steadies the page before its capture — waits out spinners, dismisses overlays, primes lazy content — because an inaccurate capture poisons every test written from it. Tick to capture immediately instead; also skipped automatically when the agent role has no key.',
        advanced: true,
      },
      {
        name: 'context',
        label: 'Include repository context',
        type: 'boolean',
        help: 'Adds what the project index knows — routes, components, what already covers this page — to the prompt. Build the index in the Context tab first.',
      },
      {
        name: 'api',
        label: 'API tests from the indexed spec',
        type: 'boolean',
        help: 'Writes HTTP tests from an indexed OpenAPI spec instead of reading a page. With no spec indexed it refuses rather than inventing URLs.',
      },
      {
        name: 'suite',
        label: 'Suite destination',
        type: 'text',
        placeholder: 'defaults to <report-dir>/<page>/suite.json',
        help: 'Where the generated suite JSON is written.',
        advanced: true,
      },
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  {
    id: 'author',
    argv: ['author'],
    title: 'Author one test',
    blurb: 'Describe a test in a sentence; get one runnable flow.',
    browser: true,
    roles: ['generator'],
    fields: [
      {
        name: 'prompt',
        label: 'What should the test check?',
        type: 'textarea',
        positional: 1,
        required: true,
        placeholder: 'check pagination is disabled when there is a single page',
        help: 'One behaviour, stated plainly. This becomes one flow, not a suite.',
      },
      {
        name: 'url',
        label: 'Page to check it against',
        type: 'text',
        placeholder: 'http://localhost:3000/some/page',
        help: 'Strongly recommended. With it the model is held to selectors that really appear in the page; without it every selector is a guess and the result is a skeleton, not a test.',
      },
      {
        name: 'run',
        label: 'Run it immediately',
        type: 'boolean',
        default: true,
        help: 'Execute the authored flow as soon as it is written.',
      },
      SCOPE_FIELD,
      POLICY_FIELD,
      {
        name: 'probe',
        label: 'Open menus first',
        type: 'boolean',
        help: 'Same disclosure-opening pass as generation, for controls that live behind a menu.',
      },
      {
        name: 'no-agent-capture',
        label: 'Capture without the agent pilot',
        type: 'boolean',
        help: 'By default an agent steadies the page before its capture — waits out spinners, dismisses overlays, primes lazy content — because an inaccurate capture poisons every test written from it. Tick to capture immediately instead; also skipped automatically when the agent role has no key.',
        advanced: true,
      },
      {
        name: 'flow',
        label: 'Flow destination',
        type: 'text',
        placeholder: 'defaults to <report-dir>/<page>/<name>.flow.json',
        help: 'Where the authored flow is written.',
        advanced: true,
      },
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  // Describe and Add Context both land here. Neither has a catalog to start
  // from, and until now both jumped straight to a flow — so what ran was never
  // written down in a form anyone could review, and the gate the catalog path is
  // built around was skipped. They draft the sheet instead, in the project's own
  // format, and stop; `catalog-run` picks it up from there.
  {
    id: 'draft',
    argv: ['draft'],
    title: 'Draft a catalog',
    blurb:
      'Turn a description, a spec, or a page into a test catalog in this project’s format. Nothing is run.',
    browser: false,
    roles: ['generator'],
    fields: [
      {
        name: 'subject',
        label: 'What should this cover?',
        type: 'text',
        positional: 1,
        placeholder: 'the probation review inbox and its urgency tiers',
        help: 'Plain language. Leave it empty if the supporting documents below already say what to cover.',
      },
      {
        name: 'context-doc',
        label: 'Spec or requirements document',
        type: 'text',
        repeatable: true,
        help: 'Read as source material for the cases. Markdown, CSV, HTML, text, JSON, YAML, Excel or PDF.',
      },
      {
        name: 'url',
        label: 'Page to write it against',
        type: 'text',
        placeholder: 'http://localhost:3000/th/workflows/probation',
        help: 'Optional, and worth giving: menu paths and control names then match what is really on screen instead of being guessed.',
      },
      {
        name: 'catalog-out',
        label: 'Where the catalog goes',
        type: 'text',
        placeholder: 'defaults to <report-dir>/catalogs/<subject>.csv',
        help: 'A CSV with this project’s columns — the same shape catalog reads back.',
      },
      {
        name: 'max-cases-drafted',
        label: 'Max cases',
        type: 'number',
        default: 20,
        min: 1,
        help: 'Cap on how many cases one draft may contain.',
      },
    ],
  },

  // A catalog is one CLI command and two panel actions, because the gate
  // between them is the point: the first lists what a document claims and
  // stops, the second tests only what survived the review.
  {
    id: 'catalog-claims',
    argv: ['catalog'],
    fixedFlags: ['--claims-only'],
    title: 'Read a catalog',
    blurb: 'List what a document says must be true. One cheap model call, no browser, nothing run.',
    browser: false,
    roles: ['generator'],
    fields: [
      {
        name: 'catalog',
        label: 'The document',
        type: 'text',
        positional: 1,
        required: true,
        placeholder: 'requirements.md, cases.xlsx, spec.pdf',
        help: 'Markdown, CSV, HTML, plain text, JSON, YAML, Excel or PDF. Its text is read out and sent to the model; the file itself is never uploaded anywhere.',
      },
      {
        name: 'claims-out',
        label: 'Where the claims go',
        type: 'text',
        placeholder: 'defaults to <report-dir>/catalogs/<name>.claims.json',
        help: 'A JSON file, one entry per claim, each with an "approved" flag you can turn off.',
      },
      {
        name: 'context-doc',
        label: 'Supporting document',
        type: 'text',
        repeatable: true,
        help: 'Background the model may read to understand terms — never a source of claims. Not the same as the repository index.',
      },
      {
        name: 'max-claims',
        label: 'Max claims',
        type: 'number',
        default: 40,
        min: 1,
        help: 'Cap on how many claims to read out of one document.',
      },
    ],
  },

  {
    id: 'catalog-run',
    argv: ['catalog'],
    title: 'Prove a catalog',
    blurb: 'Turn the approved claims into a test against a page, and run it.',
    browser: true,
    roles: ['generator'],
    fields: [
      {
        name: 'catalog',
        label: 'The document',
        type: 'text',
        positional: 1,
        required: true,
        help: 'The same document the claims were read from.',
      },
      {
        name: 'claims',
        label: 'Reviewed claims file',
        type: 'text',
        required: true,
        help: 'Only claims with "approved": true are tested. Everything else is left in the file and ignored.',
      },
      {
        name: 'url',
        label: 'Page to prove it against',
        type: 'text',
        placeholder: 'http://localhost:3000/some/page',
        help: 'Strongly recommended: with it the selectors come from the page rather than from the document, which is the difference between a test and a guess.',
      },
      {
        name: 'repo',
        label: 'Saved repository',
        type: 'text',
        placeholder: 'slug or path from context add',
        help: 'Ground the authored steps in a saved repository’s indexed routes, endpoints and tables. Save one with "context add"; an unknown value fails loudly rather than authoring ungrounded.',
      },
      {
        name: 'run',
        label: 'Run it immediately',
        type: 'boolean',
        default: true,
        help: 'The flow is written out either way, so it can be re-run later without asking a model again.',
      },
      {
        name: 'context-doc',
        label: 'Supporting document',
        type: 'text',
        repeatable: true,
        help: 'Background for the model while it writes the steps. Same documents as the claims phase.',
      },
      POLICY_FIELD,
      {
        name: 'probe',
        label: 'Open menus first',
        type: 'boolean',
        help: 'Opens the page’s disclosures so controls that only exist after a click can be asserted on.',
      },
      {
        name: 'no-agent-capture',
        label: 'Capture without the agent pilot',
        type: 'boolean',
        help: 'By default an agent steadies the page before its capture — waits out spinners, dismisses overlays, primes lazy content — because an inaccurate capture poisons every test written from it. Tick to capture immediately instead; also skipped automatically when the agent role has no key.',
        advanced: true,
      },
      {
        name: 'flow',
        label: 'Flow destination',
        type: 'text',
        help: 'Where the authored flow is written.',
        advanced: true,
      },
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  {
    id: 'crawl',
    argv: ['crawl'],
    title: 'Crawl',
    blurb: 'Follow every control on a page: does a real page come back, can we get home again.',
    browser: true,
    fields: [
      {
        name: 'url',
        label: 'Start URL',
        type: 'text',
        positional: 1,
        required: true,
        placeholder: 'http://localhost:3000',
        help: 'The page whose links get followed.',
      },
      {
        name: 'max-pages',
        label: 'Max destinations',
        type: 'number',
        default: 20,
        min: 1,
        help: 'How many links to follow. Anything beyond the budget is reported, never silently dropped.',
      },
      {
        name: 'follow-buttons',
        label: 'Follow buttons too',
        type: 'boolean',
        help: 'Needed for apps that route from rows and cards. A link is a GET; a button is anything — so this is off by default. Even on, a short label that reads like an action (Approve, Delete, Submit…) is never clicked.',
      },
      {
        name: 'max-heal',
        label: 'Heals per control',
        type: 'number',
        default: 5,
        min: 0,
        help: 'Repair attempts before falling back to navigating by URL. Every attempt is recorded, successful or not.',
      },
      {
        name: 'timeout',
        label: 'Per-navigation budget (seconds)',
        type: 'number',
        default: 30,
        min: 1,
        help: 'A slow route is slow, not broken. Measured across navigation, settle and click.',
      },
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  {
    id: 'watch',
    argv: ['watch'],
    title: 'Watch',
    blurb: 'Re-run a flow on an interval, speaking up only when the result changes.',
    browser: true,
    longRunning: true,
    fields: [
      {
        name: 'flow',
        label: 'Flow file',
        type: 'text',
        positional: 1,
        required: true,
        placeholder: 'examples/login.flow.json',
        help: 'The flow to re-run.',
      },
      {
        name: 'every',
        label: 'Interval',
        type: 'text',
        default: '15m',
        placeholder: '30s | 15m | 2h',
        help: 'How often to re-run.',
      },
      {
        name: 'notify',
        label: 'Notify command',
        type: 'text',
        placeholder: 'scripts/slack.sh',
        help: 'Run this when the result CHANGES — green→red, red→green, or newly flaky — with the verdict as JSON on its stdin. Silence means nothing changed.',
      },
      {
        name: 'until-fail',
        label: 'Stop at the first failure',
        type: 'boolean',
        help: 'Otherwise it runs until you stop it.',
      },
      ...COMMON_BROWSER_FIELDS,
    ],
  },

  {
    id: 'doctor',
    argv: ['doctor'],
    title: 'Doctor',
    blurb: 'Make one real call per model role. The only way to know a model id still resolves.',
    browser: false,
    fields: [],
  },

  {
    id: 'cache-list',
    argv: ['cache', 'list'],
    title: 'List healed selectors',
    blurb: 'Every repair the healer has cached, with its confidence and hit count.',
    browser: false,
    fields: [
      {
        name: 'cache',
        label: 'Cache file',
        type: 'text',
        placeholder: 'defaults to the configured cache path',
        help: 'Which cache file to read.',
        advanced: true,
      },
    ],
  },

  {
    id: 'cache-forget',
    argv: ['cache', 'forget'],
    title: 'Forget a repair',
    blurb: 'Drop a cached selector so the next run resolves it fresh.',
    browser: false,
    fields: [
      {
        name: 'key',
        label: 'Cache key',
        type: 'text',
        positional: 1,
        placeholder: 'http://localhost:3000/orders :: role=button[name="Save"]',
        help: 'Copy one from the Cache tab. Leave empty and tick "all" to clear everything.',
      },
      {
        name: 'all',
        label: 'Forget everything',
        type: 'boolean',
        help: 'Clears the whole cache.',
      },
      {
        name: 'cache',
        label: 'Cache file',
        type: 'text',
        help: 'Which cache file to write.',
        advanced: true,
      },
    ],
  },

  {
    id: 'history-clear',
    argv: ['history', 'clear'],
    title: 'Clear run history',
    blurb:
      'Delete every proof bundle and forget every trend. Reports already written are left alone.',
    browser: false,
    fields: [
      {
        name: 'out',
        label: 'Proof directory',
        type: 'text',
        help: 'Which directory of proof bundles to clear. Defaults to the one runs are written to.',
        advanced: true,
      },
    ],
  },

  {
    id: 'context-build',
    argv: ['context', 'build'],
    title: 'Build the project index',
    blurb: 'Statically index routes, components, existing tests and API operations. No model call is made.',
    browser: false,
    fields: [
      {
        name: 'root',
        label: 'Project root',
        type: 'text',
        placeholder: '.',
        help: 'The repository to index — usually the app under test, not wowlidator itself.',
      },
      {
        name: 'openapi',
        label: 'OpenAPI spec',
        type: 'text',
        placeholder: './openapi.yaml or an https URL',
        help: 'Indexes endpoints alongside the code, giving API generation a real inventory. Omit and a conventionally-named openapi.*/swagger.* file is used if one exists.',
      },
      {
        name: 'db-schema',
        label: 'Database schema',
        type: 'text',
        placeholder: './schema.sql or ./prisma/schema.prisma',
        help: 'Indexes tables alongside the code, giving catalog authoring a declared inventory for DB checks. Omit and a conventionally-named schema file is used; with WOWLIDATOR_DB_URL set and no file, the live schema is introspected.',
      },
      {
        name: 'force',
        label: 'Rebuild even if unchanged',
        type: 'boolean',
        help: 'Ignores the cached signature and walks everything again.',
      },
      {
        name: 'context-out',
        label: 'Graph destination',
        type: 'text',
        placeholder: '.wowlidator/context-graph.json',
        help: 'Where the graph is cached.',
        advanced: true,
      },
    ],
  },

  {
    id: 'context-add',
    argv: ['context', 'add'],
    title: 'Save a repository',
    blurb:
      'Scan a repository and remember it, so any verification can ground itself in what that code declares — routes, components, API operations, existing tests. No model call is made; re-running on the same path re-scans it.',
    browser: false,
    fields: [
      {
        name: 'path',
        label: 'Repository path',
        type: 'text',
        positional: 1,
        required: true,
        placeholder: '/absolute/path/to/the/app-under-test',
        help: 'The application repository, not wowlidator itself. Saved under a slug you select on later runs.',
      },
      {
        name: 'openapi',
        label: 'OpenAPI spec',
        type: 'text',
        placeholder: './openapi.yaml or an https URL',
        help: 'Indexes endpoints alongside the code. Remembered, so every later re-scan keeps them.',
      },
      {
        name: 'db-schema',
        label: 'Database schema',
        type: 'text',
        placeholder: './schema.sql or ./prisma/schema.prisma',
        help: 'Indexes tables alongside the code. With WOWLIDATOR_DB_URL set and no file, the live schema is introspected.',
      },
      {
        name: 'force',
        label: 'Rebuild even if unchanged',
        type: 'boolean',
        help: 'Ignores the cached signature and walks everything again.',
      },
    ],
  },

  {
    id: 'context-list',
    argv: ['context', 'list'],
    title: 'Saved repositories',
    blurb: 'List every repository saved with context add — slug, path, size, last scan.',
    browser: false,
    fields: [],
  },

  {
    id: 'context-show',
    argv: ['context', 'show'],
    title: 'Show the project index',
    blurb: 'Summarise what the index currently knows.',
    browser: false,
    fields: [
      {
        name: 'root',
        label: 'Project root',
        type: 'text',
        placeholder: '.',
        help: 'Which project’s graph to read.',
      },
      {
        name: 'json',
        label: 'Full graph as JSON',
        type: 'boolean',
        help: 'Prints every node and edge instead of a summary.',
      },
      {
        name: 'context-out',
        label: 'Graph location',
        type: 'text',
        help: 'Where the graph was cached.',
        advanced: true,
      },
    ],
  },
];

export function commandById(id: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.id === id);
}

export class UiCommandError extends Error {}

/**
 * Turn a validated form submission into an argv array.
 *
 * Everything is checked against the spec: an unknown field, an enum value that
 * is not one of the choices, or a non-finite number is an error rather than
 * something passed through to `parseArgs` to reject later. Values become
 * single argv entries, so no quoting or escaping is involved anywhere.
 */
export function buildArgv(spec: CommandSpec, values: Record<string, unknown>): string[] {
  for (const key of Object.keys(values)) {
    if (!spec.fields.some((f) => f.name === key)) {
      throw new UiCommandError(`unknown option "${key}" for ${spec.id}`);
    }
  }

  const positionals: string[] = [];
  const flags: string[] = [...(spec.fixedFlags ?? [])];

  for (const field of spec.fields) {
    const raw = values[field.name];

    if (field.repeatable) {
      if (raw === undefined || raw === null) continue;
      if (!Array.isArray(raw)) throw new UiCommandError(`"${field.name}" must be a list`);
      for (const entry of raw) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          throw new UiCommandError(`every "${field.name}" must be a non-empty string`);
        }
        if (entry.includes('\0')) throw new UiCommandError(`"${field.name}" contains a NUL byte`);
        flags.push(`--${field.name}`, entry.trim());
      }
      continue;
    }

    if (field.type === 'boolean') {
      if (raw === undefined || raw === false) continue;
      if (raw !== true) throw new UiCommandError(`"${field.name}" must be true or false`);
      flags.push(`--${field.name}`);
      continue;
    }

    let text: string;
    if (raw === undefined || raw === null || raw === '') {
      if (field.required) throw new UiCommandError(`"${field.label}" is required`);
      continue;
    } else if (typeof raw === 'string' || typeof raw === 'number') {
      text = String(raw).trim();
    } else {
      throw new UiCommandError(`"${field.name}" must be text`);
    }
    if (text === '') {
      if (field.required) throw new UiCommandError(`"${field.label}" is required`);
      continue;
    }
    // spawn takes argv directly, so the only character that could confuse the
    // handoff is a NUL — everything else is inert without a shell involved.
    if (text.includes('\0')) throw new UiCommandError(`"${field.name}" contains a NUL byte`);

    if (field.type === 'enum') {
      if (!field.choices?.includes(text)) {
        throw new UiCommandError(`"${field.name}" must be one of ${field.choices?.join(', ')}`);
      }
    }
    if (field.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new UiCommandError(`"${field.label}" must be a number`);
      if (field.min !== undefined && n < field.min) {
        throw new UiCommandError(`"${field.label}" must be at least ${field.min}`);
      }
      text = String(n);
    }

    if (field.positional !== undefined) {
      positionals[field.positional - 1] = text;
    } else {
      flags.push(`--${field.name}`, text);
    }
  }

  // A gap would silently shift every later positional along one.
  for (const [index, value] of positionals.entries()) {
    if (value === undefined) {
      const missing = spec.fields.find((f) => f.positional === index + 1);
      throw new UiCommandError(`"${missing?.label ?? `argument ${index + 1}`}" is required`);
    }
  }

  return [...spec.argv, ...positionals, ...flags];
}

/** How the same run would have been typed. Shown in the UI above every run. */
export function formatCommandLine(argv: readonly string[]): string {
  const quoted = argv.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a));
  return `wowlidator ${quoted.join(' ')}`;
}
