/**
 * The accounts the panel has been told about, so it can offer them again.
 *
 * A catalog whose rows change hands names several accounts, and the launcher
 * asks for each of them by label. Typing the same three addresses before every
 * run is the part of that which is pure friction — the addresses do not change
 * between runs, and the person retyping them is the same person who typed them
 * yesterday.
 *
 * **Only the address is remembered. The password is asked for every time.**
 * That is the whole security posture of this file and it is not a tuning
 * knob: a store holding both halves would be a credential on disk that can
 * sign in on its own, next to a panel that binds to a port. An address alone
 * opens nothing. So the API boundary takes `{ label, email }` — never a
 * persona map, never a whole form value — because the shape that cannot carry
 * a password is the one that cannot leak one by accident, and `remember()`
 * rebuilds each record from those two fields rather than spreading what it was
 * handed. `tests/persona-accounts.test.ts` asserts a password-shaped extra
 * property reaches neither the file nor the read-back.
 *
 * Everything else here follows the conventions the rest of the repo already
 * keeps for a small local file:
 *
 * - **Labels are normalised** through the CLI's own `personaLabelOf`, the rule
 *   `parsePersonas` and `personasValueToMap` apply, so `<manager account>` and
 *   `MANAGER_ACCOUNT` are one key and the launcher cannot fail to recognise an
 *   account it stored under another spelling of the same name.
 * - **Most recently used first**, and re-using an address moves it back to the
 *   front rather than adding a second copy — the list is an offer, and the
 *   right first offer is the last thing that worked.
 * - **Capped per label**, so a machine that has seen a hundred test accounts
 *   grows neither a hundred-option dropdown nor an unbounded file.
 * - **Written temp-file-then-rename**, like the ledger and the cache, and a
 *   corrupt or unreadable file reads as "nothing remembered" with a line to
 *   stderr. Never fatal: a run must not fail because the panel's memory of an
 *   address could not be parsed.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { personaLabelOf } from '../cli/options.js';

export const PERSONA_ACCOUNTS_FILE = '.wowlidator/persona-accounts.json';

/** The file's shape version — an older or newer one reads as empty. */
export const PERSONA_ACCOUNTS_VERSION = 1;

/**
 * How many addresses are kept per label. Eight is well past what a QA machine
 * actually uses (one real account plus a few spares) and keeps the dropdown a
 * list a person can read.
 */
export const MAX_ACCOUNTS_PER_LABEL = 8;

/** Addresses are not secrets, but nothing unbounded goes in a file either. */
const MAX_EMAIL_CHARS = 254;

/** One remembered address. There is deliberately no third field. */
export interface RememberedAccount {
  email: string;
  /** ISO stamp of the last run started with it — what the ordering is by. */
  lastUsedAt: string;
}

/** What the store is told. Label and address; there is no shape for a secret. */
export interface PersonaAccountRef {
  label: string;
  email: string;
}

export interface PersonaAccountsFile {
  version: number;
  accounts: Record<string, RememberedAccount[]>;
}

/**
 * An address worth remembering: one line of plain text, no control character
 * or space in it. Not a judgement about what an email is — the CLI never made
 * one either — only a guard on what reaches the file.
 */
function usableEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  if (email === '' || email.length > MAX_EMAIL_CHARS) return null;
  for (let i = 0; i < email.length; i += 1) {
    const code = email.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  return email;
}

function isoOr(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw !== '' && !Number.isNaN(Date.parse(raw)) ? raw : fallback;
}

/**
 * A parsed file, with every entry rebuilt from the two fields that belong in
 * it. Anything else the JSON carried — including something called `password`
 * that a hand-edit or a future bug put there — does not survive the read, so
 * it can reach neither a page nor the next write.
 */
export function readAccountsFrom(raw: string): Record<string, RememberedAccount[]> {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const file = parsed as Partial<PersonaAccountsFile>;
  if (file.version !== PERSONA_ACCOUNTS_VERSION) return {};
  if (file.accounts === null || typeof file.accounts !== 'object' || Array.isArray(file.accounts)) return {};

  const accounts: Record<string, RememberedAccount[]> = {};
  for (const [rawLabel, list] of Object.entries(file.accounts as Record<string, unknown>)) {
    const label = personaLabelOf(String(rawLabel));
    if (label === '' || !Array.isArray(list)) continue;
    const kept: RememberedAccount[] = [];
    for (const entry of list as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue;
      const email = usableEmail((entry as { email?: unknown }).email);
      if (email === null || kept.some((one) => one.email.toLowerCase() === email.toLowerCase())) continue;
      kept.push({ email, lastUsedAt: isoOr((entry as { lastUsedAt?: unknown }).lastUsedAt, '') });
      if (kept.length >= MAX_ACCOUNTS_PER_LABEL) break;
    }
    if (kept.length > 0) accounts[label] = kept;
  }
  return accounts;
}

/**
 * The panel's memory of which addresses each account label has been run as.
 *
 * One instance per server, holding one file. The path is the server's own —
 * nothing a client sends is joined onto it, which is why no method here takes
 * a path at all.
 */
export class PersonaAccountStore {
  readonly #file: string;
  /** Writes are serialised: two launches at once must not lose one another. */
  #queue: Promise<void> = Promise.resolve();

  constructor(file: string = resolve(PERSONA_ACCOUNTS_FILE)) {
    this.#file = file;
  }

  get file(): string {
    return this.#file;
  }

  /** Label → addresses, most recently used first. A missing file is `{}`. */
  async read(): Promise<Record<string, RememberedAccount[]>> {
    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch {
      return {};
    }
    try {
      return readAccountsFrom(raw);
    } catch (error) {
      // The cache's rule: say so once, then behave as if nothing were stored.
      process.stderr.write(`wowlidator ui: ignoring unreadable ${this.#file}: ${String(error)}\n`);
      return {};
    }
  }

  /**
   * Remember the address each label was run as. Never throws: a store that
   * cannot be written must not stop a run that has already started.
   *
   * Only `label` and `email` are read off each reference, and the record
   * written is built from those two alone — so even a caller that hands this a
   * richer object writes an address and a stamp, and nothing else.
   */
  remember(refs: readonly PersonaAccountRef[], at: string = new Date().toISOString()): Promise<void> {
    const wanted: { label: string; email: string }[] = [];
    for (const ref of refs) {
      if (ref === null || typeof ref !== 'object') continue;
      const label = personaLabelOf(String(ref.label ?? ''));
      const email = usableEmail(ref.email);
      if (label === '' || email === null) continue;
      wanted.push({ label, email });
    }
    if (wanted.length === 0) return this.#queue;

    this.#queue = this.#queue
      .then(async () => {
        const accounts = await this.read();
        for (const { label, email } of wanted) {
          const rest = (accounts[label] ?? []).filter(
            (one) => one.email.toLowerCase() !== email.toLowerCase(),
          );
          // Front, not appended: the last address that ran is the one the
          // launcher should offer first next time.
          accounts[label] = [{ email, lastUsedAt: at }, ...rest].slice(0, MAX_ACCOUNTS_PER_LABEL);
        }
        const file: PersonaAccountsFile = { version: PERSONA_ACCOUNTS_VERSION, accounts };
        await mkdir(dirname(this.#file), { recursive: true });
        const temp = `${this.#file}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
        await rename(temp, this.#file);
      })
      .catch((error: unknown) => {
        process.stderr.write(`wowlidator ui: could not remember an account: ${String(error)}\n`);
      });
    return this.#queue;
  }

  /** Waits for any queued write — for a caller that needs the file on disk. */
  flush(): Promise<void> {
    return this.#queue;
  }
}
