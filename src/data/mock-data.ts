/**
 * Deterministic mock-data generation — the default path for `fillRetry`.
 *
 * No model call: most "email already exists" conflicts are resolved by
 * generating a value nothing has seen before, not by reasoning about what to
 * type. AI escalation (`DataModel`, the `custom` kind) lives in
 * `data-model.ts`, for a field a heuristic can't classify — not for the
 * common case, which is why most `fillRetry` steps never reach a model at
 * all.
 */

import { faker } from '@faker-js/faker';

export const DATA_KINDS = ['email', 'username', 'name', 'phone', 'text', 'custom'] as const;
export type DataKind = (typeof DATA_KINDS)[number];

type DeterministicKind = Exclude<DataKind, 'custom'>;

const GENERATORS: Record<DeterministicKind, () => string> = {
  email: () => faker.internet.email({ provider: 'example.com' }),
  username: () => faker.internet.username(),
  name: () => faker.person.fullName(),
  phone: () => faker.phone.number(),
  text: () => faker.lorem.words(3),
};

/** True for every kind this module can generate without a model. */
export function isDeterministicKind(kind: DataKind): kind is DeterministicKind {
  return kind !== 'custom';
}

/**
 * A short, unique-per-call suffix, embedded rather than appended blindly —
 * an email needs it before the `@`, everything else after.
 */
function withUniqueSuffix(base: string, kind: DeterministicKind, attempt: number): string {
  const suffix = `${Date.now().toString(36)}${attempt}`;
  if (kind === 'email') {
    const at = base.indexOf('@');
    return at === -1 ? `${base}+${suffix}` : `${base.slice(0, at)}+${suffix}${base.slice(at)}`;
  }
  if (kind === 'username') return `${base}${suffix}`;
  return `${base} ${suffix}`;
}

/**
 * Generate one fresh value for `kind`. `attempt` beyond the first embeds a
 * uniqueness suffix — plain faker randomness is *statistically* safe against
 * collision, but a retry loop's entire premise is that the previous value
 * conflicted with something, so attempt 2+ makes that structurally
 * impossible rather than merely unlikely.
 *
 * Throws for `custom` — that kind has no deterministic generator by design;
 * see `DataModel`.
 */
export function generateValue(kind: DataKind, attempt = 1): string {
  if (!isDeterministicKind(kind)) {
    throw new Error(`"${kind}" has no deterministic generator — use a DataModel instead`);
  }
  const base = GENERATORS[kind]();
  return attempt <= 1 ? base : withUniqueSuffix(base, kind, attempt);
}

// --- unique per run -------------------------------------------------------------

/**
 * The last six alphanumerics of a catalog run key —
 * `be100@2026-08-31t07-20-25-957z` → `25957z`.
 *
 * Six because the run key's tail is its timestamp, and the tail moves on every
 * pass; alphanumerics only because the suffix lands in a Plan ID, a rule name
 * or a document code, and `-957z` with the key's own hyphen reads as a range
 * where the app wants an identifier.
 */
export function runSuffix(runKey: string): string {
  const compact = runKey.replace(/[^A-Za-z0-9]+/g, '');
  return compact.slice(-6);
}

/**
 * A key value made unique to THIS run: `PL_06_21` → `PL_06_21_25957z`.
 *
 * The BE sheet's create rows set the unique field to the case id itself
 * (`Benefit Plan ID = PL_06_21`, `Benefit name = QA-Insert`, Consent `SIT_*`
 * codes). On any rerun the app answers "Plan ID already exists" and the create
 * case fails for a reason the case never asked about; the sheet's own testers
 * appended `_R1`/`_R2`/`_R3` by hand (PL_06_21_R3 is in the workbook). This is
 * that hand, deterministic: the same case in the same run always gets the same
 * value, so an assertion that echoes the id still matches what was typed.
 */
export function uniquePerRun(value: string, runKey: string): string {
  const suffix = runSuffix(runKey);
  if (suffix === '') return value;
  return `${value}_${suffix}`;
}
