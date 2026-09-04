/**
 * Which API key a run starts on, and how the panel is allowed to talk about it.
 *
 * The rotation itself already exists and is not here: `LlmFactory.callWithFailover`
 * walks a provider's configured keys whenever a call fails in a way that looks
 * like the key (auth, quota, rate limit) rather than the request, and stays on
 * whichever key answered. That happens *inside* a run. This module is the other
 * half of the same idea — which key a run **begins** at, chosen from the panel,
 * and what the browser is allowed to be told about any of them.
 *
 * Three rules, and the first is the one that matters:
 *
 * - **A key value never leaves this process.** The browser is sent a mask
 *   (`gsk_…a91f`) and an index. Selecting a key is a POST of that *index*, not
 *   of a secret. A panel that rendered a live credential into a page would put
 *   it in the DOM, in the browser's memory, and in any screenshot of the
 *   window — for no gain, since nothing in the UI needs the characters.
 * - **Selecting a key reorders, it never removes.** The chosen key is moved to
 *   the front of the list the spawned CLI sees, so the run starts there and
 *   failover still has everything else to fall back into. Sending only the
 *   chosen key would silently turn a two-key setup into a one-key one at the
 *   exact moment the user was trying to work around a bad key.
 * - **Nothing here writes to `.env`.** The selection lives in the running
 *   panel and lasts as long as it does. Editing the file is a decision about
 *   the machine, not about this run, and the panel does not make it for you.
 */

import { PROVIDERS, PROVIDER_META, LLM_ROLES, type LlmRole, type ProviderName, type WowlidatorConfig } from '../config.js';

/**
 * Enough of a key to recognise it, never enough to use it.
 *
 * Providers prefix their keys (`gsk_`, `sk-or-v1-`, `AIza`), so the head is
 * what tells one provider's key from another's and the tail is what tells two
 * keys of the same provider apart. A key too short to split is shown as
 * nothing at all rather than as most of itself.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 12) return '•'.repeat(Math.max(trimmed.length, 4));
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export interface KeyView {
  index: number;
  /** `gsk_…a91f`. The only form of a key that ever reaches the browser. */
  mask: string;
  /** Whether a run started now would begin on this key. */
  active: boolean;
}

export interface ProviderKeysView {
  provider: ProviderName;
  label: string;
  envKey: string;
  consoleUrl: string;
  freeTier: string;
  keys: KeyView[];
  /** Which key a run started now would begin at. Always 0 until someone picks. */
  activeIndex: number;
  /** The roles routed to this provider — why it matters that it works. */
  roles: LlmRole[];
}

export interface RoleKeyView {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
  keyed: boolean;
  /** The mask of the key this role would start on, or null when it has none. */
  activeMask: string | null;
  keyCount: number;
}

export class KeySelectionError extends Error {}

/**
 * The panel's per-provider "start here" cursor.
 *
 * Deliberately not merged into `WowlidatorConfig`: the config is what the
 * environment says, and this is what a person clicked in a browser five
 * seconds ago. Keeping them separate is what makes "reload from .env" mean
 * something — the config is replaced, and a selection that no longer points at
 * a key is dropped rather than silently pointing at a different one.
 */
export class KeySelection {
  readonly #active = new Map<ProviderName, number>();

  activeIndex(provider: ProviderName): number {
    return this.#active.get(provider) ?? 0;
  }

  /**
   * Point a provider at one of its configured keys.
   *
   * The index is validated against the config rather than trusted: it arrives
   * from a browser, and an out-of-range index would otherwise become a
   * `MissingApiKeyError` thrown much later, inside a run, about something the
   * user did not do.
   */
  select(provider: ProviderName, index: number, config: WowlidatorConfig): void {
    const keys = config.apiKeys[provider] ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
      throw new KeySelectionError(
        keys.length === 0
          ? `no ${PROVIDER_META[provider].label} key is configured — set ${PROVIDER_META[provider].envKey} in .env`
          : `${PROVIDER_META[provider].label} has ${keys.length} key(s); ${index + 1} is not one of them`,
      );
    }
    this.#active.set(provider, index);
  }

  /** Forget any selection that no longer names a key — used after a reload. */
  prune(config: WowlidatorConfig): void {
    for (const [provider, index] of [...this.#active.entries()]) {
      if (index >= (config.apiKeys[provider]?.length ?? 0)) this.#active.delete(provider);
    }
  }

  /** What the browser may know: masks, counts, which one is active, and why it matters. */
  describe(config: WowlidatorConfig): { providers: ProviderKeysView[]; roles: RoleKeyView[] } {
    const providers = PROVIDERS.map((provider) => {
      const keys = config.apiKeys[provider] ?? [];
      const activeIndex = keys.length === 0 ? 0 : this.activeIndex(provider);
      return {
        provider,
        label: PROVIDER_META[provider].label,
        envKey: PROVIDER_META[provider].envKey,
        consoleUrl: PROVIDER_META[provider].consoleUrl,
        freeTier: PROVIDER_META[provider].freeTier,
        keys: keys.map((key, index) => ({
          index,
          mask: maskKey(key),
          active: index === activeIndex,
        })),
        activeIndex,
        roles: LLM_ROLES.filter((role) => config.roles[role].provider === provider),
      };
    });

    const roles = LLM_ROLES.map((role) => {
      const entry = config.roles[role];
      const keys = config.apiKeys[entry.provider] ?? [];
      const active = keys[this.activeIndex(entry.provider)];
      return {
        role,
        provider: entry.provider,
        modelId: entry.modelId,
        keyed: keys.length > 0,
        activeMask: active === undefined ? null : maskKey(active),
        keyCount: keys.length,
      };
    });

    return { providers, roles };
  }

  /**
   * The environment a spawned run should inherit, given this selection.
   *
   * Only providers whose cursor has moved appear — an untouched provider keeps
   * whatever the real environment already had, rather than having its own
   * value handed back to it in a slightly different shape.
   *
   * The chosen key goes first and **every other key follows**, in their
   * original order. That is what keeps the two halves of this feature
   * compatible: the run starts where the panel said, and `callWithFailover`
   * still has the rest to move through when that key turns out to be the
   * problem after all.
   */
  envOverlay(config: WowlidatorConfig): Record<string, string> {
    const overlay: Record<string, string> = {};
    for (const provider of PROVIDERS) {
      const index = this.#active.get(provider);
      if (index === undefined || index === 0) continue;
      const keys = config.apiKeys[provider] ?? [];
      if (keys[index] === undefined) continue;
      overlay[PROVIDER_META[provider].envKey] = this.orderedKeyIndexes(provider, config)
        .map((i) => keys[i] as string)
        .join(',');
    }
    return overlay;
  }

  /**
   * The order a run started now would walk this provider's keys: the chosen
   * one first, every other in its original order behind it. Indexes into
   * `config.apiKeys[provider]`, so a caller can name the real key afterwards
   * — the panel's model check reports "answered on key 2" in the numbering
   * the key cards use, not in the reordered list's.
   */
  orderedKeyIndexes(provider: ProviderName, config: WowlidatorConfig): number[] {
    const count = config.apiKeys[provider]?.length ?? 0;
    const all = Array.from({ length: count }, (_, i) => i);
    const chosen = this.#active.get(provider) ?? 0;
    if (chosen === 0 || chosen >= count) return all;
    return [chosen, ...all.filter((i) => i !== chosen)];
  }
}
