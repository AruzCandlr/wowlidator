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

export type FieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'enum' | 'secret';

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
  /**
   * Required only when another boolean field on this form is on.
   *
   * The backend toggle is the case this exists for: turning backend testing
   * ON is the moment a database connection stops being optional, and asking
   * for it up front — before a run spends ten minutes to die on the first DB
   * step — is the whole point of a toggle. Validated in `buildArgv` /
   * `buildEnvOverlay`, so the rule holds whatever posts the form.
   */
  requiredWhen?: { field: string; equals: true };
  /**
   * The flag to send when this boolean is OFF, for a CLI option that is on by
   * default.
   *
   * `backend` is the case: the CLI keeps backend testing ON so every existing
   * script and catalog behaves as it always did, while the panel offers it as
   * opt-IN — which is what a person actually wants in front of them, since
   * most runs have no database configured. The panel therefore states its
   * choice explicitly in both directions rather than relying on a default
   * that differs between the two surfaces.
   */
  offFlag?: string;
  min?: number;
  /**
   * May be given more than once, becoming `--name a --name b`. The UI sends an
   * array; anything else is rejected, so a repeatable flag cannot be smuggled
   * in as one string containing a separator.
   */
  repeatable?: boolean;
  /**
   * For a `secret` field: the environment variable that carries the value to
   * the spawned CLI. A secret NEVER becomes argv — argv is what `ps` prints,
   * what the panel displays as the run's command line, and what the job
   * record keeps, and a password must appear in none of them. The CLI already
   * reads this variable as the fallback for the flag (`WOWLIDATOR_AS`), so
   * the env route is the same feature, not a second code path.
   */
  envVar?: string;
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

/**
 * How many cases of a suite may run at once. Offered by the two commands that
 * run a list of cases (a catalog, a generated suite); a single flow has
 * nothing to run beside. `1` is the strictly sequential run and the A/B test
 * for a parallel result that looks wrong. A case that changes data runs alone
 * whatever this says.
 */
const AUTHOR_CONCURRENCY_FIELD: Field = {
  name: 'author-concurrency',
  label: 'Rows authored at a time',
  type: 'number',
  default: 3,
  min: 1,
  help: 'How many rows of a test-case table are written side by side, each with its own tab and its own model call. With a run, a finished case starts at once. Set 1 to author one after another — the way to tell whether a surprising flow was caused by batching.',
  advanced: true,
};

const AUTHOR_ATTEMPTS_FIELD: Field = {
  name: 'author-attempts',
  label: 'Authoring attempts per row',
  type: 'number',
  default: 3,
  min: 1,
  help:
    'Total asks per row including the first — a refused flow is re-asked with the refusal as feedback. ' +
    '1 is one ask and no re-ask budget: fastest and cheapest, at the price of weaker flows being handed over. ' +
    'Blank uses the Machinery dial.',
  advanced: true,
};

const CONCURRENCY_FIELD: Field = {
  name: 'concurrency',
  label: 'Cases at a time',
  type: 'number',
  default: 4,
  min: 1,
  help: 'How many cases run side by side, each in its own browser context. A case that changes data (fills a form, calls a writing endpoint, asserts on the database) always runs alone. Set 1 to run one after another — the way to tell whether a surprising result was caused by running in parallel.',
  advanced: true,
};

/**
 * The account a run may sign in with, offered on every command that consumes
 * it (run, go, generate --run, author, catalog --run, watch). One field in
 * the CLI's own `--as` shape rather than two, so what the panel teaches is
 * exactly what a terminal invocation looks like. Carried to the CLI as
 * WOWLIDATOR_AS (see `Field.envVar`); the runner masks the password wherever
 * it lands in a record, and the session bootstrap is what makes this the
 * difference between a fresh headless Chrome dying on the login screen and
 * the run establishing the session itself.
 */
/**
 * Autoheal — `--repair` worn as the launcher's own words. On a failed / error /
 * dead-end result the repair model rewrites the flow around the break and the
 * case reruns itself, up to the attempt budget. Suites heal per case through
 * the same loop `run --repair` uses; a clean pass costs nothing extra.
 */
const AUTOHEAL_FIELD: Field = {
  name: 'repair',
  label: 'Autoheal enabled',
  type: 'boolean',
  help:
    'When the result is failed, error or dead-end, the repair model rewrites the flow around the ' +
    'break and the test reruns itself, up to 3 total runs. Every rewrite lands as its own ' +
    'reviewable .attempt-N.flow.json plus a .patch; assertions always keep their claim, so a ' +
    'test is never rewritten until it merely passes.',
};

/**
 * Whether this run tests the backend at all.
 *
 * On, the author may write HTTP and database steps, and `DB_URL_FIELD` below
 * becomes required — a DB claim with no database is a case that dies ten
 * minutes in, and asking here costs nothing. Off, no backend step is written:
 * every claim is proved through the page, and a claim that a backend check
 * would prove better carries a note saying so (`ProofStep.backendHint`),
 * which is the honest form of "we did not check that half".
 */

/**
 * The database baseline (`src/db/baseline.ts`): snapshot the tables under test
 * before the run, compare on every backend step, and optionally restore them
 * after. Shown on the catalog form because that is the run that writes to the
 * app's database case after case.
 */
const DB_BASELINE_FIELD: Field = {
  name: 'db-baseline',
  label: 'Database baseline',
  type: 'enum',
  choices: ['auto', 'off', 'snapshot', 'restore'],
  default: 'auto',
  advanced: true,
  help:
    'auto: as much as the connections allow — nothing without WOWLIDATOR_DB_URL, snapshot-and-compare with it, ' +
    'restore too when WOWLIDATOR_DB_RESTORE_URL (a write credential) is also set. snapshot: detect the tables the ' +
    'flows are about, snapshot them, and record on every backend step what it did to them — no restore. restore: ' +
    'also put the tables back after the run. off: none of it.',
};

const BACKEND_FIELD: Field = {
  name: 'backend',
  label: 'Include backend steps',
  type: 'boolean',
  default: false,
  offFlag: 'no-backend',
  help:
    'On: the test may call HTTP endpoints and read the database directly, and a database URL is ' +
    'required below. Off: nothing but the page is used — a claim that wants the backend is still ' +
    'proved visually, and the step is marked as one a backend check could prove more directly.',
};

const DB_URL_FIELD: Field = {
  name: 'db-url',
  label: 'Database URL',
  type: 'secret',
  envVar: 'WOWLIDATOR_DB_URL',
  placeholder: 'postgres://user@host:5432/database',
  requiredWhen: { field: 'backend', equals: true },
  help:
    'Read-only access for database checks, e.g. postgres://user@localhost:5432/app. It travels to ' +
    'the CLI as an environment variable, never in the command line. Leave it blank to use whatever ' +
    'the panel’s own environment already sets.',
};

const CREDENTIALS_FIELD: Field = {
  name: 'as',
  label: 'Sign in as',
  type: 'secret',
  envVar: 'WOWLIDATOR_AS',
  placeholder: 'email:password',
  help: 'The account the run may use — email and password joined by the first colon (a password may contain colons). With it, a flow that lands on the sign-in page establishes the session itself; the authored steps also fill these exact characters instead of guessing. The value travels to the CLI as an environment variable, never in the command line, and the password is masked in every record.',
};

/**
 * Credentials by persona label (CG-05), for cases that sign in as several
 * people. `LABEL=email:password` entries, one per line or `;`-separated;
 * they become the `WOWLIDATOR_PERSONAS` JSON map the CLI reads. A secret,
 * like `--as`: never argv, never a record.
 */
const PERSONAS_FIELD: Field = {
  name: 'personas',
  label: 'Personas',
  type: 'secret',
  envVar: 'WOWLIDATOR_PERSONAS',
  placeholder: 'EMPLOYEE_ACCOUNT=emp@x.test:pw; MANAGER_ACCOUNT=mgr@x.test:pw',
  help: 'Credentials by persona label for cases that hand off between people — an employee submits, a manager approves. One LABEL=email:password per line (or separated by ";"); the labels match the sheet’s <LABEL> tokens. Each persona gets a Chrome of its own for the length of the case and keeps its session, so a later signIn as the first persona switches back without a login. Never in the command line; passwords are masked in every record.',
};

/** The sign-in group: the one account, and the persona map beside it. */
const SIGN_IN_FIELDS: readonly Field[] = [CREDENTIALS_FIELD, PERSONAS_FIELD];

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
    // `all` rather than `auto` (2026-09-04): a filmed run under `auto` keeps a
    // still only where a step FAILED, so the evidence for everything that
    // passed is a video frame someone has to scrub to. The panel is where a
    // person reads a run afterwards, and a full-resolution still per step is
    // what they open. The cost is report size, which is a cost worth naming
    // rather than one worth defaulting away from.
    default: 'all',
    help: 'all keeps a full-resolution still for every step, alongside the film — what a reader opens when they want to see exactly what a step saw, and the panel default for that reason. It costs report size: the same run captured twice. auto follows the recording instead — failures only while filming, since the video already covers the rest, and every step when filming is off. Each capture costs 50–150ms, plus the settle below.',
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
    name: 'no-agent-early-stop',
    label: 'Disable the agent’s early give-up',
    type: 'boolean',
    help: 'By default a workflow leg concedes after 3 turns finding nothing to act on, or 5 with no progress. Tick to raise both to 25 — the agent keeps trying far longer before conceding a leg. Slower and more thorough; use when a control is reachable but takes many steps.',
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
    name: 'browsers',
    label: 'Chromes to run across',
    type: 'number',
    min: 1,
    placeholder: '1',
    help: 'How many browsers a parallel run spreads its cases over: the one on the CDP port plus this many minus one on the ports after it, each on its own profile, started headless. One Chrome’s main thread queues every lane’s renderer, encoder and CDP session, so a run at 8 cases waits on Chrome rather than on the application — 4 browsers is a good start. A case that signs in as several people gets one Chrome per person with every session kept; the pool grows on demand when this is blank, and with Headless off you watch employee and manager side by side.',
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
    name: 'no-target-highlight',
    label: 'Leave screenshots unmarked',
    type: 'boolean',
    help: 'By default each step\'s screenshot draws a red rectangle around the element the step acted on or checked — the proof of WHAT was tested, not only the page it sat on. The target (selector, role, name, position) is recorded on the step either way. Tick to leave the stills unmarked.',
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
  default: 'mutations',
  help: 'mutations (default): fills, submits, creates and updates — like a human tester. forms: only empty/invalid submits, to exercise validation. read-only: never submits. Never deletes, at any tier.',
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
      AUTOHEAL_FIELD,
      ...SIGN_IN_FIELDS,
      BACKEND_FIELD,
      DB_URL_FIELD,
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
        // A list runs every file as one suite job — one browser slot, a
        // roll-up, and `[cN]`-tagged output — which is how the group-level
        // "Rerun all" / "Heal all" buttons re-run a whole catalog without a
        // click per case. A lone string is still the single-flow form.
        repeatable: true,
        required: true,
        placeholder: 'examples/login.flow.json',
        help: 'Pick one from the Flows tab, or type a path. Several run as one suite.',
      },
      {
        name: 'repair',
        label: 'Autoheal enabled',
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
      ...SIGN_IN_FIELDS,
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
        name: 'no-author-review',
        label: 'Skip the authoring review',
        type: 'boolean',
        help: 'By default every authored flow gets a second look before it is written: steps with nothing behind them (a control named in no captured tree, a path no route declares) are checked by the agent role against the codebase index and the documents, repointed only when the evidence supports it, and reported either way. Tick to write the flow exactly as authored.',
        advanced: true,
      },
      {
        name: 'no-value-resolution',
        label: 'Leave placeholder values unresolved',
        type: 'boolean',
        help: "By default a value the sheet leaves as a token (<NON_EXISTING_EMPLOYEE_ID>) or a description (\"an existing employee\") is resolved before the flow is written: from the case's own test data, then the documents and repository index, then the database (read-only, only when WOWLIDATOR_DB_URL is set), and as a last resort the generator invents a well-formed value and the step is FLAGGED as generated — on the step, in every report, and in the run notes. Tick to skip this and have such a step refused instead.",
        advanced: true,
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
      CONCURRENCY_FIELD,
      AUTOHEAL_FIELD,
      ...SIGN_IN_FIELDS,
      BACKEND_FIELD,
      DB_URL_FIELD,
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
        name: 'no-author-review',
        label: 'Skip the authoring review',
        type: 'boolean',
        help: 'By default every authored flow gets a second look before it is written: steps with nothing behind them (a control named in no captured tree, a path no route declares) are checked by the agent role against the codebase index and the documents, repointed only when the evidence supports it, and reported either way. Tick to write the flow exactly as authored.',
        advanced: true,
      },
      {
        name: 'no-value-resolution',
        label: 'Leave placeholder values unresolved',
        type: 'boolean',
        help: "By default a value the sheet leaves as a token (<NON_EXISTING_EMPLOYEE_ID>) or a description (\"an existing employee\") is resolved before the flow is written: from the case's own test data, then the documents and repository index, then the database (read-only, only when WOWLIDATOR_DB_URL is set), and as a last resort the generator invents a well-formed value and the step is FLAGGED as generated — on the step, in every report, and in the run notes. Tick to skip this and have such a step refused instead.",
        advanced: true,
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
      ...SIGN_IN_FIELDS,
      BACKEND_FIELD,
      DB_URL_FIELD,
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
        name: 'resume-from',
        label: 'Rerun from case id',
        type: 'text',
        help: 'Run again from this case ONWARD in plan order — earlier verdicts are kept, everything from it (passes included) reruns on the current config. Implies Continue.',
      },
      {
        name: 'rerun-case',
        label: 'Re-author one case by id',
        type: 'text',
        repeatable: true,
        help: 'Re-author exactly this case from its sheet row — fresh flow, current code — and run it, whatever its recorded verdict. Repeatable. Implies Continue.',
      },
      {
        name: 'resume',
        label: 'Continue where the last run stopped',
        type: 'boolean',
        default: false,
        help: 'Continue the same catalog run under its run key: cases the progress file beside the claims file already has a verdict for are pulled in as finished tests; the ones that never ran or were never reached run now.',
      },
      {
        name: 'rerun-vacuous',
        label: 'Re-author cases that proved nothing',
        type: 'boolean',
        default: false,
        help: 'Cases whose flow only asserted the sign-in and a URL are re-authored and run. Implies Continue.',
      },
      {
        name: 'rerun-errors',
        label: 'Rerun cases that ended in a runtime error',
        type: 'boolean',
        default: false,
        help: 'A runtime error is the harness, not a verdict: those cases run again. Implies Continue.',
      },
      {
        name: 'rerun-failed',
        label: 'Heal and rerun failed cases',
        type: 'boolean',
        default: false,
        help: 'Failed and dead-end cases run again with autoheal on. Implies Continue and Autoheal.',
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
        name: 'no-author-review',
        label: 'Skip the authoring review',
        type: 'boolean',
        help: 'By default every authored flow gets a second look before it is written: steps with nothing behind them (a control named in no captured tree, a path no route declares) are checked by the agent role against the codebase index and the documents, repointed only when the evidence supports it, and reported either way. Tick to write the flow exactly as authored.',
        advanced: true,
      },
      {
        name: 'no-value-resolution',
        label: 'Leave placeholder values unresolved',
        type: 'boolean',
        help: "By default a value the sheet leaves as a token (<NON_EXISTING_EMPLOYEE_ID>) or a description (\"an existing employee\") is resolved before the flow is written: from the case's own test data, then the documents and repository index, then the database (read-only, only when WOWLIDATOR_DB_URL is set), and as a last resort the generator invents a well-formed value and the step is FLAGGED as generated — on the step, in every report, and in the run notes. Tick to skip this and have such a step refused instead.",
        advanced: true,
      },
      {
        name: 'no-agent-capture',
        label: 'Capture without the agent pilot',
        type: 'boolean',
        help: 'By default an agent steadies the page before its capture — waits out spinners, dismisses overlays, primes lazy content — because an inaccurate capture poisons every test written from it. Tick to capture immediately instead; also skipped automatically when the agent role has no key.',
        advanced: true,
      },
      AUTHOR_CONCURRENCY_FIELD,
      AUTHOR_ATTEMPTS_FIELD,
      CONCURRENCY_FIELD,
      AUTOHEAL_FIELD,
      {
        name: 'flow',
        label: 'Flow destination',
        type: 'text',
        help: 'Where the authored flow is written.',
        advanced: true,
      },
      ...SIGN_IN_FIELDS,
      BACKEND_FIELD,
        DB_BASELINE_FIELD,
      DB_URL_FIELD,
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
      ...SIGN_IN_FIELDS,
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
        name: 'context-doc',
        label: 'Remember a context document',
        type: 'text',
        repeatable: true,
        placeholder: '.wowlidator/context-docs/spec.md',
        help:
          'A document remembered WITH the repository — markdown, text, PDF, PowerPoint, Excel or CSV. ' +
          'Every run grounded in this repo reads it automatically, fresh from disk, so an edited file ' +
          'updates itself; re-adding a file of the same name replaces the remembered one.',
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
 * The panel's persona text as the map the CLI reads from `WOWLIDATOR_PERSONAS`:
 * `LABEL=email:password` entries separated by newlines or `;`, the label
 * trimmed of `<…>` and upper-cased as `parsePersonas` would. Refused, never
 * dropped, when an entry is malformed — the CLI's rule for the same reason.
 */
export function personasFieldToMap(raw: string, label = 'Personas'): Record<string, { email: string; password: string }> {
  const map: Record<string, { email: string; password: string }> = {};
  for (const line of raw.split(/[\n;]+/)) {
    const item = line.trim();
    if (item === '') continue;
    const eq = item.indexOf('=');
    if (eq <= 0) throw new UiCommandError(`"${label}": each entry must be LABEL=email:password (got "${item.split(':')[0] ?? item}")`);
    const key = item.slice(0, eq).trim().replace(/^<|>$/g, '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const pair = item.slice(eq + 1);
    const at = pair.indexOf(':');
    if (key === '' || at <= 0 || pair.slice(at + 1) === '') {
      throw new UiCommandError(`"${label}": ${key || '?'} must be LABEL=email:password, both halves present`);
    }
    map[key] = { email: pair.slice(0, at).trim(), password: pair.slice(at + 1) };
  }
  if (Object.keys(map).length === 0) throw new UiCommandError(`"${label}": no LABEL=email:password entries found`);
  return map;
}

/** One persona as a structured form sends it: the secret half separate from the label. */
export interface PersonaEntry {
  email: string;
  password: string;
}

/**
 * The `personas` value, in either shape the panel can send it.
 *
 * The typed lines (`LABEL=email:password`, `;`- or newline-separated) are what
 * a person writes into the textarea, and `personasFieldToMap` still owns them.
 * A structured record is what the launcher's per-account form sends, and it is
 * not a convenience. The text form splits on `/[\n;]+/` before it splits on the
 * first `:`, so a password containing a semicolon or a newline breaks in one of
 * two ways, measured:
 *
 *   `A=a@x.test:p;w`               → throws about a fragment ("got \"w\"") that
 *                                    matches nothing the person typed;
 *   `A=a@x.test:p;B=b@x.test:q`    → **silently** gives A the password `p` and
 *                                    invents an account B — a run that then
 *                                    starts with one wrong credential and one
 *                                    account nobody asked for.
 *
 * The second is the reason this exists. A form collecting several accounts at
 * once cannot offer a syntax whose failure mode is a plausible-looking wrong
 * answer.
 *
 * Both shapes normalise the label exactly as `personaLabelOf` does — the
 * sheet's `<MANAGER_ACCOUNT>`, a bare `MANAGER_ACCOUNT` and `manager account`
 * are one key — so the two paths cannot disagree about who is who. An entry
 * missing either half is refused, never dropped: a persona silently absent is
 * a run that dies at its second sign-in, which is the failure this exists to
 * end.
 */
export function personasValueToMap(
  raw: unknown,
  label = 'Personas',
): Record<string, PersonaEntry> {
  if (typeof raw === 'string') return personasFieldToMap(raw, label);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UiCommandError(`"${label}" must be text or one entry per account`);
  }
  const map: Record<string, PersonaEntry> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim().replace(/^<|>$/g, '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (key === '') throw new UiCommandError(`"${label}": an account has no label`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new UiCommandError(`"${label}": ${key} must have an email and a password`);
    }
    const { email, password } = value as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new UiCommandError(`"${label}": ${key} must have an email and a password`);
    }
    if (email.trim() === '' || password === '') {
      throw new UiCommandError(`"${label}": ${key} is missing its ${email.trim() === '' ? 'email' : 'password'}`);
    }
    if (`${email}${password}`.includes('\0')) throw new UiCommandError(`"${label}": ${key} contains a NUL byte`);
    map[key] = { email: email.trim(), password };
  }
  if (Object.keys(map).length === 0) throw new UiCommandError(`"${label}": no accounts were given`);
  return map;
}

/**
 * The environment a submission's secret fields become.
 *
 * The mirror of `buildArgv`, for the values that must not be argv: each
 * `secret` field with a non-empty value lands in its `envVar`, validated here
 * so a malformed pair fails the submission with a sentence rather than
 * failing the run thirty seconds in. Empty means "not supplied" and
 * contributes nothing — the spawned CLI then falls back to whatever the
 * panel's own environment says, exactly as a terminal run would.
 */
export function buildEnvOverlay(
  spec: CommandSpec,
  values: Record<string, unknown>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const field of spec.fields) {
    if (field.type !== 'secret' || field.envVar === undefined) continue;
    const raw = values[field.name];
    if (raw === undefined || raw === null || raw === '') {
      // A secret's own required-when lives here, because `buildArgv` skips
      // secrets entirely — argv is exactly where they must never appear.
      if (field.requiredWhen !== undefined && values[field.requiredWhen.field] === true) {
        throw new UiCommandError(
          `"${field.label}" is required when "${field.requiredWhen.field}" is on`,
        );
      }
      continue;
    }
    if (field.name === 'personas') {
      // Before the text guard, because the launcher's per-account form sends a
      // record rather than a line — and a password with a `;` or a newline in
      // it survives only on that path. Either shape becomes the same JSON map
      // `parsePersonas` reads.
      //
      // An empty record is "not supplied", the same as an empty box: the form
      // sends only the accounts it actually has, and a catalog whose personas
      // are all set in the machine's own environment sends none.
      if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw as object).length === 0) continue;
      env[field.envVar] = JSON.stringify(personasValueToMap(raw, field.label));
      continue;
    }
    if (typeof raw !== 'string') throw new UiCommandError(`"${field.label}" must be text`);
    if (raw.includes('\0')) throw new UiCommandError(`"${field.name}" contains a NUL byte`);
    if (field.name === 'as') {
      // The CLI's own rule (`parseCredentials`): first colon separates, both
      // halves non-empty. Checked here so the panel says so immediately.
      const at = raw.indexOf(':');
      if (at <= 0 || raw.slice(at + 1) === '') {
        throw new UiCommandError(
          `"${field.label}" must be email:password — the first colon separates them`,
        );
      }
    }
    env[field.envVar] = raw;
  }
  return env;
}

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

    if (field.repeatable && field.positional !== undefined) {
      // A repeatable *positional* (run's flow files): entries become
      // consecutive argv positions. A lone string is accepted as a
      // one-entry list — it is still exactly one argv entry, so nothing can
      // be smuggled through it — because every single-flow caller (the
      // classic panel's form, wowUI's per-run buttons) sends a string.
      const list =
        raw === undefined || raw === null || raw === ''
          ? []
          : Array.isArray(raw)
            ? raw
            : [raw];
      if (list.length === 0) {
        if (field.required) throw new UiCommandError(`"${field.label}" is required`);
        continue;
      }
      let slot = field.positional - 1;
      for (const entry of list) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          throw new UiCommandError(`every "${field.name}" must be a non-empty string`);
        }
        if (entry.includes('\0')) throw new UiCommandError(`"${field.name}" contains a NUL byte`);
        positionals[slot++] = entry.trim();
      }
      continue;
    }

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
      if (raw !== undefined && raw !== true && raw !== false) {
        throw new UiCommandError(`"${field.name}" must be true or false`);
      }
      if (raw !== true) {
        // Off, and the CLI's own default is on: say so out loud — but only
        // when the submission actually SAID off. An absent field means "not
        // stated", and turning the backend off for every caller that simply
        // did not mention it would be a behaviour change smuggled in through
        // a default.
        if (raw === false && field.offFlag !== undefined) flags.push(`--${field.offFlag}`);
        continue;
      }
      flags.push(`--${field.name}`);
      continue;
    }

    // A secret is validated here and carried by `buildEnvOverlay`; it must
    // never reach the argv whatever the submission says.
    if (field.type === 'secret') continue;

    if (field.requiredWhen !== undefined && (raw === undefined || raw === null || raw === '')) {
      if (values[field.requiredWhen.field] === true) {
        throw new UiCommandError(
          `"${field.label}" is required when "${field.requiredWhen.field}" is on`,
        );
      }
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
