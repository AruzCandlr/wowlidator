/**
 * The GRIM visual system, as one set of CSS custom properties.
 *
 * Ported from the two UIs in `grim-agent`, which were two different-looking
 * applications sharing one job. They are treated here as **light and dark modes
 * of a single system** rather than two systems:
 *
 *   light  ← `apps/qa_command_center/src/styles/theme.css`
 *            paper #F7F7F4, ink #1C2126, teal #0E8A9E, IBM Plex.
 *            GRIM's evidence UI: hairline borders, status chips with a dot,
 *            uppercase micro-labels, mono for anything a human might re-run.
 *   dark   ← `apps/orchestrator_3_stream/frontend/src/styles/global.css`
 *            #0a0a0a canvas, cyan #06b6d4 telemetry, purple agent accent.
 *
 * Note for anyone diffing against `grim-agent`: its `DESIGN.md` describes a
 * *dark* cyan/Geist-Mono instrument panel, but the CSS that actually ships in
 * the QA Command Center is the light IBM Plex one. The code was taken as the
 * source of truth over the document.
 *
 * ## Two rules this file exists to keep
 *
 * **No external requests, ever.** wowlidator's HTML report has to open off a
 * USB stick — there is a test asserting no `<script src>`, no external
 * stylesheet, no remote image — so the fonts are declared as stacks that prefer
 * IBM Plex when the reader happens to have it and degrade to the platform UI
 * font when they do not. A `fonts.googleapis.com` link would fail that test and,
 * worse, would make an evidence artefact phone home.
 *
 * **One vocabulary, three surfaces.** The report, the control panel and
 * grimval's verification report all consume these same names. Adding a colour
 * to one surface means adding a token here, which is what stops the three
 * drifting into three dialects of nearly-the-same.
 */

/** Every colour, in both modes. Names are the contract; values are the theme. */
export const GRIM_TOKENS = `
:root {
  color-scheme: light dark;

  /* surface — QA Command Center */
  --bg: #F7F7F4;
  --panel: #FFFFFF;
  --panel-2: #FAFAF8;
  --line: #E5E7E3;
  --line-strong: #D3D6D0;

  /* ink */
  --ink: #1C2126;
  --muted: #5C6873;
  --faint: #98A2AC;

  /* accent — teal is "active system telemetry" */
  --accent: #0E8A9E;
  --accent-soft: #E4F3F5;
  --accent-line: #BCDFE6;
  /*
   * Three accents, because one is not enough to stay legible.
   *
   * --accent is for hairlines, icons and large type. It is NOT safe as a
   * background behind white text: #0E8A9E/white is 4.08:1, under the 4.5 AA
   * needs for body-sized text, and the cyan it becomes in dark mode is 2.43:1,
   * which is unreadable. Measured in a browser, not estimated.
   *
   *   --accent-strong  a solid fill that can carry --on-accent
   *   --on-accent      the only colour allowed on top of --accent-strong
   *   --accent-ink     accent-coloured *text*, legible on --accent-soft
   */
  --accent-strong: #0A6B7A;
  --on-accent: #FFFFFF;
  --accent-ink: #0A6B7A;

  /* semantics: green verified, amber review/gap, red no-go, blue running */
  --ok: #1B7F4B;        --ok-bg: #E7F4EC;
  --warn: #B45309;      --warn-bg: #FBF0E1;
  --bad: #B91C1C;       --bad-bg: #FBE9E9;
  --info: #2563EB;      --info-bg: #E8EEFC;
  /* the one derived value: the QA palette has no violet, the orchestrator's is
     tuned for a black canvas, so this is that hue brought down for paper */
  --violet: #6D28D9;    --violet-bg: #F1EAF9;

  /* type — IBM Plex when present, platform UI when not. No network. */
  --sans: "IBM Plex Sans Thai", "IBM Plex Sans", -apple-system, BlinkMacSystemFont,
          "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --fs-cap: 11px;
  --fs-xs: 12.5px;
  --fs-sm: 13.5px;
  --fs-md: 14px;
  --fs-lg: 17px;
  --fs-xl: 23px;
  --fs-mono: 11.5px;

  /* space */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px; --s6: 24px; --s7: 32px;

  /* radius — GRIM clips rather than rounds; nothing here is pill-shaped by default */
  --r-xs: 4px; --r-sm: 8px; --r-lg: 14px; --r-pill: 999px;
  --radius: 8px;

  /* elevation — restrained; the border does most of the work */
  --shadow: 0 1px 2px rgba(28,33,38,.03), 0 2px 6px -2px rgba(28,33,38,.04);
  --shadow-over: 0 18px 44px -16px rgba(28,33,38,.28), 0 2px 8px -2px rgba(28,33,38,.08);
  --code-bg: #F2F3F0;
}

${darkBlock(':root:not([data-theme="light"])', '@media (prefers-color-scheme: dark)')}
${darkBlock(':root[data-theme="dark"]')}
`;

/**
 * The dark mode, emitted twice: once behind `prefers-color-scheme` for readers
 * who never touch a control, and once behind `[data-theme="dark"]` so an
 * explicit toggle wins over the OS in *both* directions. The light selector
 * carries `:not([data-theme="light"])` for the same reason — without it, a
 * reader on a dark OS who asks for light gets dark anyway.
 */
function darkBlock(selector: string, wrapper?: string): string {
  const body = `${selector} {
  /* surface — Orchestrator 3 Stream */
  --bg: #0a0a0a;
  --panel: #1a1a1a;
  --panel-2: #1e1e1e;
  --line: #333333;
  --line-strong: #404040;

  /* ink */
  --ink: #ffffff;
  --muted: #b0b0b0;
  --faint: #6b7280;

  /* accent — cyan telemetry */
  --accent: #06b6d4;
  --accent-soft: #0c2b33;
  --accent-line: #14505c;
  /* Cyan is too light to sit under white text, so a solid cyan action takes
     near-black instead — which is also how the orchestrator's telemetry reads. */
  --accent-strong: #06b6d4;
  --on-accent: #06232a;
  --accent-ink: #22c9e4;

  --ok: #10b981;        --ok-bg: #0c2a1f;
  --warn: #f59e0b;      --warn-bg: #33260c;
  --bad: #ef4444;       --bad-bg: #331616;
  --info: #3b82f6;      --info-bg: #12203a;
  --violet: #a855f7;    --violet-bg: #251435;

  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
  --shadow-over: 0 18px 44px -16px rgba(0,0,0,.7), 0 2px 8px -2px rgba(0,0,0,.5);
  --code-bg: #16181c;
}`;
  return wrapper ? `${wrapper} {\n${body}\n}` : body;
}

/** Reset, body, links, focus. Everything a surface needs before components. */
export const GRIM_BASE = `
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--fs-md);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
code, pre, .mono, .num, .time { font-family: var(--mono); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
/* Visible focus is not optional — the QA app's stated AA target, kept. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

/**
 * The components every GRIM surface shares.
 *
 * Deliberately small. These are the four marks that make the system
 * recognisable — the hairline panel, the dotted status chip, the uppercase
 * micro-label, and mono for anything a reader might paste into a terminal.
 * Surface-specific styling stays in the surface.
 */
export const GRIM_COMPONENTS = `
/* panel: a tonal surface with a hairline border. The border does the work. */
.g-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--shadow);
}

/* micro-label: uppercase, tracked, for scanability. Never for prose. */
.g-cap {
  font-size: var(--fs-cap);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
}

/* chip: a status word with a dot. The dot is what makes a wall of them scan. */
.g-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-cap);
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  white-space: nowrap;
  background: var(--panel-2);
  color: var(--muted);
}
.g-chip::before {
  content: "";
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}
.g-chip.pass    { background: var(--ok-bg);     color: var(--ok); }
.g-chip.fail    { background: var(--bad-bg);    color: var(--bad); }
.g-chip.warn    { background: var(--warn-bg);   color: var(--warn); }
.g-chip.info    { background: var(--info-bg);   color: var(--info); }
.g-chip.active  { background: var(--accent-soft); color: var(--accent-ink); }
.g-chip.idle    { background: var(--panel-2);   color: var(--faint); }

/* a bare verdict word, for inside a dense table where a chip would be noise */
.g-verdict { font-weight: 700; font-size: var(--fs-xs); letter-spacing: .04em; }
.g-verdict::before {
  content: "";
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  margin-right: 6px;
  background: currentColor;
}
.g-verdict.pass { color: var(--ok); }
.g-verdict.fail { color: var(--bad); }
.g-verdict.warn { color: var(--warn); }
.g-verdict.idle { color: var(--faint); }

/* anything a reader might re-run belongs in mono, on its own tone */
.g-cmd {
  font-family: var(--mono);
  font-size: var(--fs-mono);
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  padding: 1px 6px;
  overflow-wrap: anywhere;
}

/* dense data table: hairlines, uppercase head, mono figures */
.g-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.g-table th {
  text-align: left;
  font-size: var(--fs-cap);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--line-strong);
  white-space: nowrap;
}
.g-table td {
  padding: var(--s3);
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.g-table tr:last-child td { border-bottom: 0; }
.g-table td.num { font-family: var(--mono); font-size: var(--fs-mono); color: var(--muted); white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

/** Tokens + base + components, in the order a document needs them. */
export function grimTheme(): string {
  return `${GRIM_TOKENS}\n${GRIM_BASE}\n${GRIM_COMPONENTS}`;
}

/**
 * Palette values exposed to JS, for the few places a colour has to be computed
 * rather than declared — an inline SVG fill, a canvas, a meta theme-color.
 * Keep in step with the CSS above; there is a test asserting they agree.
 */
export const GRIM_PALETTE = {
  light: { bg: '#F7F7F4', panel: '#FFFFFF', ink: '#1C2126', accent: '#0E8A9E' },
  dark: { bg: '#0a0a0a', panel: '#1a1a1a', ink: '#ffffff', accent: '#06b6d4' },
} as const;

/** Semantic role for a run/verdict word, so three surfaces classify alike. */
export type GrimTone = 'pass' | 'fail' | 'warn' | 'info' | 'active' | 'idle';

/**
 * One mapping from the words these systems actually emit to a tone.
 *
 * Shared so that "ORACLE_UNAVAILABLE" is amber in grimval's report, in
 * wowlidator's report and in the control panel, rather than amber in whichever
 * two of them someone remembered to update.
 */
export function toneOf(word: string): GrimTone {
  switch (word.toLowerCase()) {
    case 'pass':
    case 'passed':
    case 'verified':
    case 'ok':
      return 'pass';
    case 'fail':
    case 'failed':
    case 'escalated':
      return 'fail';
    case 'oracle_unavailable':
    case 'blocked':
    case 'refused':
    case 'unsure':
    case 'flaky':
    case 'quarantined':
      return 'warn';
    case 'running':
    case 'first-run':
      return 'info';
    case 'active':
      return 'active';
    default:
      return 'idle';
  }
}
