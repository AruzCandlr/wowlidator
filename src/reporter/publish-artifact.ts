/**
 * Publishing a report as an artifact, from the report itself.
 *
 * A generated report is a file. Handing one to somebody means attaching it, or
 * asking them to trust a path on a machine they do not have — which is how a
 * run that proved something ends up unread. An artifact is a URL, so the report
 * grows a button that turns itself into one.
 *
 * **The mechanism, and why it is this one.** Publishing needs the `Artifact`
 * tool, and that tool exists only in a full Claude Code session. Measured on
 * 2026-09-08, because the obvious choice is the wrong one: `claude -p` (print
 * mode) does NOT have it — not in its tool list, not as a deferred tool via
 * `ToolSearch`, and not when named in `--allowedTools`, which grants a tool
 * that exists rather than registering one that does not. `claude --bg` does
 * have it. So this spawns a backgrounded session, never a print call.
 *
 * The publish still raises Claude Code's own permission prompt — it uploads to
 * Anthropic's servers, which is exactly the kind of outward-facing act that
 * ought to ask. That prompt is part of this design, not an obstacle to route
 * around: the button starts a publish, a person allows it.
 *
 * Everything here is pure except `publishArtifact` — the strip, the budget and
 * the argv are decided with no filesystem and no process, so they are tested
 * with neither.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/**
 * What a published artifact may weigh. The platform's ceiling is 16 MB; the
 * budget sits under it because the HTML is measured here and the platform
 * measures what it stores, and being wrong in that direction wastes a publish.
 */
export const ARTIFACT_BUDGET_BYTES = 15_000_000;

/**
 * The `<video data-webm="…">` payload a report embeds — base64, and usually
 * most of the file.
 *
 * Found by scanning, NOT by a regex. `data-webm="[A-Za-z0-9+/=]{1000,}"` reads
 * correctly and dies on the only input that matters: a 21 MB payload overflows
 * V8's stack inside `RegExp.test` (`RangeError: Maximum call stack size
 * exceeded`), so the one report that needs stripping is the one that crashes.
 * Two `indexOf` calls have no such limit and no backtracking to reason about.
 * A test feeds it a payload past the budget for exactly this reason.
 */
const FILM_ATTR = 'data-webm="';
const FILM_MIN_CHARS = 1000;

/** The span of the embedded film's attribute value, or null when there is none worth dropping. */
function findFilm(html: string): { start: number; end: number } | null {
  const at = html.indexOf(FILM_ATTR);
  if (at < 0) return null;
  const start = at + FILM_ATTR.length;
  const end = html.indexOf('"', start);
  if (end < 0 || end - start < FILM_MIN_CHARS) return null;
  return { start, end };
}

export interface StripResult {
  html: string;
  /** Whether the film was dropped to fit. */
  strippedFilm: boolean;
  bytes: number;
}

/**
 * The report, small enough to publish.
 *
 * The film is dropped ONLY when the page does not otherwise fit: a recording is
 * the most direct evidence a report holds, and discarding it to save bytes
 * nobody was short of is a worse report for no gain. When it must go, the page
 * says so in its place rather than showing a player that will never load — a
 * silently empty `<video>` reads as a broken report, which is a lie about the
 * run rather than a fact about the size limit.
 */
export function stripToFit(html: string, budget = ARTIFACT_BUDGET_BYTES): StripResult {
  const size = (s: string): number => Buffer.byteLength(s, 'utf8');
  const film = size(html) <= budget ? null : findFilm(html);
  if (film === null) return { html, strippedFilm: false, bytes: size(html) };

  const note =
    '<p class="video-missing">The recording is not embedded in this artifact: it is past the ' +
    'size a published page may carry. It is kept with the run, beside this report. The ' +
    'filmstrip below is the same journey as stills, and every step keeps its own evidence.</p>';
  const stripped = (html.slice(0, film.start) + html.slice(film.end)).replace(
    '<div class="video-subtitle"',
    `${note}<div class="video-subtitle"`,
  );
  return { html: stripped, strippedFilm: true, bytes: size(stripped) };
}

/** `…/03-catalog-pl-01-01.html` → `…/03-catalog-pl-01-01.artifact.html`. */
export function artifactPathFor(reportPath: string): string {
  const ext = extname(reportPath);
  return join(dirname(reportPath), `${basename(reportPath, ext)}.artifact${ext === '' ? '.html' : ext}`);
}

/** The page's own `<title>`, which becomes the artifact's name. Only the head is scanned, as the platform does. */
export function titleOf(html: string, fallback: string): string {
  const found = /<title>([^<]{1,300})<\/title>/i.exec(html.slice(0, 8192))?.[1]?.trim();
  return found === undefined || found === '' ? fallback : found;
}

export interface PublishRequest {
  /** The report to publish. */
  reportPath: string;
  /** Model for the session that does the publishing. */
  model?: string | undefined;
}

/**
 * The command that publishes, as argv.
 *
 * Kept apart from the spawn so a test can assert its shape without starting a
 * session, and so the one thing that must never be shell-interpolated — a path
 * — stays an argv element. `--bg` because print mode has no `Artifact` tool;
 * `acceptEdits` so the session does not stall on the reads it makes on the
 * way, while the publish itself still asks.
 */
export function publishArgv(file: string, title: string, model = 'haiku'): string[] {
  return [
    '--bg',
    '--model',
    model,
    '--permission-mode',
    'acceptEdits',
    `Publish the file ${file} as an artifact with the Artifact tool. ` +
      `Use the title ${JSON.stringify(title)} and the favicon 🧪. ` +
      `Read the file first, publish it exactly as it is, and change nothing in it. ` +
      `Then reply with the artifact URL on one line beginning "URL: ". Ask me nothing else.`,
  ];
}

export interface PublishOutcome {
  /** The file handed to the session — the stripped copy when one was needed. */
  file: string;
  title: string;
  strippedFilm: boolean;
  bytes: number;
  /** The backgrounded session's short id, when it printed one. */
  sessionId: string | null;
}

/**
 * Publish one report: read it, fit it, write the copy, start the session.
 *
 * Returns as soon as the session is backgrounded. The publish then needs a
 * person to allow it, and holding an HTTP request open for a human decision is
 * how a panel route becomes a hung tab.
 */
export async function publishArtifact(request: PublishRequest, claude = 'claude'): Promise<PublishOutcome> {
  const html = await readFile(request.reportPath, 'utf8');
  const fitted = stripToFit(html);
  const title = titleOf(html, basename(request.reportPath));

  // A stripped page is a different page, so it is written BESIDE the report
  // rather than over it: the run's own evidence is never edited to suit a
  // publish. A page that already fits publishes from where it is.
  const file = fitted.strippedFilm ? artifactPathFor(request.reportPath) : request.reportPath;
  if (fitted.strippedFilm) await writeFile(file, fitted.html, 'utf8');

  const sessionId = await new Promise<string | null>((done) => {
    let settled = false;
    const settle = (text: string): void => {
      if (settled) return;
      settled = true;
      done(/backgrounded[^a-f0-9]*([a-f0-9]{6,})/.exec(text)?.[1] ?? null);
    };
    const child = spawn(claude, publishArgv(file, title, request.model ?? 'haiku'), {
      cwd: dirname(request.reportPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (/backgrounded/.test(out)) settle(out);
    });
    child.on('error', () => settle(''));
    child.on('close', () => settle(out));
  });

  return { file, title, strippedFilm: fitted.strippedFilm, bytes: fitted.bytes, sessionId };
}
