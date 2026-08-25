/**
 * The suite-wide pause flag — one state, every loop that starts work reads it.
 *
 * Pause was signal-only at first (SIGUSR2 into `runCases`), and the live
 * failure taught two things at once (2026-08-24, be100). First: restarting
 * the panel ORPHANS a running suite — the new panel's job list has no entry
 * for it, so no button can signal it, and the pause "does nothing". Second:
 * the signal only stopped the RUN loop, while the authoring producer kept
 * narrating new rows — so even a delivered pause looked ignored for minutes.
 *
 * Both fixed here: the flag is process-wide (the run loop AND the authoring
 * pool consult it), and it can be raised by a FILE as well as the signal —
 * `<claims>.progress.json.pause`, polled beside the ledger (and still checked
 * every time a new case would start). The panel writes that file with its
 * pause request, so a pause reaches even an orphaned run; from a terminal,
 * `touch <claims>.progress.json.pause` pauses a suite no signal can reach.
 * The file is consumed (deleted) when noticed, so a later resume does not
 * pause itself on a leftover.
 *
 * What a raised pause MEANS changed on 2026-08-24: a suite with a ledger now
 * pauses instantly (`runCases`' `onPause` writes the pause record and exits;
 * interrupted cases keep no verdict and a resume re-runs them). The
 * flag-and-file machinery here is unchanged — it is how the request travels,
 * not what it does on arrival.
 */

import { existsSync, rmSync } from 'node:fs';

let requested = false;

/** Raise the pause. With a ledger the suite exits instantly; without one,
 *  nothing new starts and whatever is in flight finishes. */
export function requestPause(): void {
  requested = true;
}

/**
 * Has a pause been asked for — by signal, an earlier check, or the pause
 * file? `pauseFile` is checked (and consumed) only while no pause is raised.
 */
export function pauseRequested(pauseFile?: string): boolean {
  if (!requested && pauseFile !== undefined && existsSync(pauseFile)) {
    requested = true;
    try {
      rmSync(pauseFile);
    } catch {
      /* consuming the marker is best-effort — the flag is already raised */
    }
  }
  return requested;
}

/** Test seam, and the reset a resume relies on within one process. */
export function resetPause(): void {
  requested = false;
}

/**
 * Remove the pause file without raising the flag. Two callers, both about
 * staleness since pause became instant: the suite start (a file written for
 * the PREVIOUS process must not pause the resume it asked for), and the
 * instant-pause exit itself (the signal usually wins the race with the file,
 * which then nobody would ever consume).
 */
export function clearPauseFile(pauseFile: string): void {
  try {
    rmSync(pauseFile);
  } catch {
    /* absent or unremovable — either way the flag decides, not the file */
  }
}

/** Where a suite's pause file lives: beside its progress ledger. */
export function pauseFileFor(ledgerPath: string): string {
  return `${ledgerPath}.pause`;
}
