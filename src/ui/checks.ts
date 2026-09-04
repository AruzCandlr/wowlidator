/**
 * "Is this role's model ready?" — asked from the panel, answered by a real call.
 *
 * The third sibling of `ui/keys.ts` and `ui/models.ts`. Those two decide what
 * a run started here begins on; this one asks whether that choice works
 * *before* a run is started on it, and remembers the answer so the page can
 * show it. The catalogue in `models.ts` deliberately cannot answer this — a
 * listed id can be rate-limited into uselessness and an unlisted one can be
 * fine — which is why that file defers to `wowlidator doctor`. This is
 * `doctor`'s probe (`providers/probe.ts`), run in the panel's own process
 * against the panel's own choices.
 *
 * ## It probes what the next run would actually get
 *
 * A check that reads `.env` while the page says the healer is on Gemini and
 * starting on key 2 would be checking somebody else's configuration. So the
 * factory is built from an *effective* config: each role's provider and model
 * as `ModelSelection` reports them, each provider's keys in the order
 * `KeySelection` would hand a spawned CLI. The key that answers is then named
 * in the numbering the key cards use, not the reordered list's.
 *
 * ## The panel's own cursors are never moved by a check
 *
 * A fresh factory per check, so a rotation the probe discovers is reported —
 * "key 1 exhausted, answered on key 2" — and not silently applied to where
 * runs start. Selecting a key is the person's decision; the check gives them
 * the evidence for it.
 *
 * ## On a click, never on a poll
 *
 * A probe costs a model call. The page polls every few seconds; a check that
 * ran on each poll would spend a role's own free-tier quota on asking whether
 * the quota is there. Results are cached until the next click or until the
 * choice they were about changes — a result for `groq:llama-3.3` says nothing
 * about `google:gemini`, so re-pointing a role drops its check rather than
 * showing a verdict about a different model.
 */

import { LLM_ROLES, type LlmRole, type ProviderName, type WowlidatorConfig } from '../config.js';
import { LlmFactory, type ModelBuilder } from '../providers/llm-factory.js';
import { probeRole, type ProbeOptions, type RoleProbe } from '../providers/probe.js';
import type { KeySelection } from './keys.js';
import { maskKey } from './keys.js';
import type { ModelSelection } from './models.js';

/** One role's last check as the browser sees it. */
export interface RoleCheckView extends RoleProbe {
  /** The mask of the key that answered, in the key cards' numbering. */
  keyMask: string | null;
  /** True while a check for this role is running. */
  running: boolean;
}

export class RoleCheckError extends Error {}

/**
 * The config a run started from this panel would see, as one object.
 *
 * Roles come from `ModelSelection` (which already folds the panel's choice over
 * what `.env` said); keys come from `KeySelection`'s ordering. Everything else
 * is the loaded config unchanged. Exported for the test that proves a check
 * follows the panel's choices rather than the file's.
 */
export function effectiveConfig(
  config: WowlidatorConfig,
  keys: KeySelection,
  models: ModelSelection,
): { config: WowlidatorConfig; keyOrder: Partial<Record<string, number[]>> } {
  const roles = { ...config.roles };
  for (const view of models.describeRoles(config)) {
    roles[view.role] = {
      role: view.role,
      provider: view.provider,
      modelId: view.modelId,
      baseUrl: view.baseUrl ?? undefined,
    };
  }
  const apiKeys: WowlidatorConfig['apiKeys'] = {};
  const keyOrder: Partial<Record<string, number[]>> = {};
  for (const [provider, list] of Object.entries(config.apiKeys)) {
    if (list === undefined) continue;
    const order = keys.orderedKeyIndexes(provider as keyof typeof config.apiKeys, config);
    keyOrder[provider] = order;
    apiKeys[provider as keyof typeof config.apiKeys] = order.map((i) => list[i] as string);
  }
  return { config: { ...config, roles, apiKeys }, keyOrder };
}

export class RoleChecks {
  readonly #last = new Map<LlmRole, RoleCheckView>();
  readonly #inFlight = new Map<LlmRole, Promise<RoleCheckView>>();
  readonly #probe: ProbeOptions;
  readonly #builders: Partial<Record<ProviderName, ModelBuilder>>;

  /**
   * @param probe Test seam — the generate call and clock the probe uses.
   * @param builders Test seam — how the factory turns a key into a model.
   */
  constructor(probe: ProbeOptions = {}, builders: Partial<Record<ProviderName, ModelBuilder>> = {}) {
    this.#probe = probe;
    this.#builders = builders;
  }

  /**
   * Probe one role against the panel's effective configuration.
   *
   * A second click while a check is running joins the first rather than
   * spending a second call on the same question.
   */
  async check(
    role: string,
    config: WowlidatorConfig,
    keys: KeySelection,
    models: ModelSelection,
  ): Promise<RoleCheckView> {
    if (!(LLM_ROLES as readonly string[]).includes(role)) {
      throw new RoleCheckError(`"${role}" is not a model role`);
    }
    const typed = role as LlmRole;
    const pending = this.#inFlight.get(typed);
    if (pending !== undefined) return pending;

    const started = this.#run(typed, config, keys, models).finally(() => {
      this.#inFlight.delete(typed);
    });
    this.#inFlight.set(typed, started);
    return started;
  }

  /** Every role, in parallel — each on its own fresh factory, so none inherits another's rotation. */
  async checkAll(
    config: WowlidatorConfig,
    keys: KeySelection,
    models: ModelSelection,
  ): Promise<RoleCheckView[]> {
    return Promise.all(LLM_ROLES.map((role) => this.check(role, config, keys, models)));
  }

  /**
   * The last result per role, or nothing for a role never checked.
   *
   * A result whose provider or model no longer matches what the role would run
   * on is dropped rather than shown: a "ready" verdict about a model the role
   * has since been moved off is the one thing this panel must never display.
   */
  describe(config: WowlidatorConfig, models: ModelSelection): RoleCheckView[] {
    const current = new Map(models.describeRoles(config).map((r) => [r.role, r]));
    const out: RoleCheckView[] = [];
    for (const [role, view] of this.#last) {
      const now = current.get(role);
      if (now === undefined || now.provider !== view.provider || now.modelId !== view.modelId) {
        this.#last.delete(role);
        continue;
      }
      out.push({ ...view, running: this.#inFlight.has(role) });
    }
    return out;
  }

  /** Roles with a check running now — shown as such, before any result exists. */
  checking(): LlmRole[] {
    return [...this.#inFlight.keys()];
  }

  async #run(
    role: LlmRole,
    config: WowlidatorConfig,
    keys: KeySelection,
    models: ModelSelection,
  ): Promise<RoleCheckView> {
    const effective = effectiveConfig(config, keys, models);
    const factory = new LlmFactory(effective.config, this.#builders);
    const probe = await probeRole(factory, role, this.#probe);

    // The probe numbers keys in the order it walked them; the cards number
    // them as `.env` lists them. Translate back, so "answered on key 2" and
    // the card that says "key 2 of 3" agree.
    const order = effective.keyOrder[probe.provider] ?? [];
    const realIndex = probe.keyIndex === null ? null : (order[probe.keyIndex] ?? probe.keyIndex);
    const realKey = realIndex === null ? undefined : config.apiKeys[probe.provider]?.[realIndex];
    const view: RoleCheckView = {
      ...probe,
      detail:
        probe.keyIndex === null || realIndex === null
          ? probe.detail
          : probe.detail.replace(
              `key ${probe.keyIndex + 1}/${probe.keyCount}`,
              `key ${realIndex + 1}/${probe.keyCount}`,
            ),
      keyIndex: realIndex,
      keyMask: realKey === undefined ? null : maskKey(realKey),
      attempts: probe.attempts.map((a) => ({ ...a, keyIndex: order[a.keyIndex] ?? a.keyIndex })),
      running: false,
    };
    this.#last.set(role, view);
    return view;
  }
}
