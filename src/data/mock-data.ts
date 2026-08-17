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
