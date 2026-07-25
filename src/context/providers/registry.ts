/**
 * Context provider registry (IDEA-F90-CTX-PROVIDERS-01).
 *
 * Owns the set of registered {@link ContextProvider}s and a per-project
 * enable/disable map, and runs all enabled providers under a single shared
 * character budget. The registry is the only place breadth is added: a new
 * provider registers here and is never wired into core. Enabling/disabling is a
 * per-project toggle (defaults to enabled), so a project can opt a provider out
 * without affecting any other project.
 *
 * Budget strategy: the total budget is divided equally across the currently
 * enabled providers, each provider runs against its share, and the concatenated
 * result is hard-capped at the total so no overflow is possible even if a
 * provider overshoots. Remainder characters from integer division are given to
 * the first providers, one each, so the full budget is usable.
 */
import type {
  ContextBudget,
  ContextProvider,
  ContextSnippet
} from "./types.js";

export interface ContextRegistrySnapshot {
  readonly providerIds: readonly string[];
  /** Per-project disable overrides: `true` means explicitly disabled. */
  readonly disabled: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export interface RunAllResult {
  readonly snippets: readonly ContextSnippet[];
  /** Per-provider character share used for this run. */
  readonly perProviderBudget: number;
  readonly enabledCount: number;
}

export class ContextRegistry {
  private readonly providers = new Map<string, ContextProvider>();
  /** projectId -> providerId -> disabled. Absence = enabled. */
  private readonly disabled = new Map<string, Set<string>>();
  private readonly insertionOrder: string[] = [];

  /** Register a provider. Re-registering the same id replaces it. */
  register(provider: ContextProvider): this {
    if (!this.providers.has(provider.id)) {
      this.insertionOrder.push(provider.id);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  /** Remove a provider entirely. Returns true if it was present. */
  unregister(id: string): boolean {
    const had = this.providers.delete(id);
    if (had) {
      const idx = this.insertionOrder.indexOf(id);
      if (idx >= 0) {
        this.insertionOrder.splice(idx, 1);
      }
      for (const set of this.disabled.values()) {
        set.delete(id);
      }
    }
    return had;
  }

  /** List registered providers in insertion order. */
  list(): readonly ContextProvider[] {
    return this.insertionOrder
      .map((id) => this.providers.get(id))
      .filter((p): p is ContextProvider => p !== undefined);
  }

  /** True if `id` is enabled for `projectId` (registered and not disabled). */
  isEnabled(id: string, projectId?: string): boolean {
    if (!this.providers.has(id)) {
      return false;
    }
    if (projectId === undefined) {
      return true;
    }
    return !this.disabled.get(projectId)?.has(id);
  }

  /**
   * Disable a provider for a project. Per-project so one workspace can opt a
   * provider out without touching any other.
   */
  disable(id: string, projectId: string): this {
    let set = this.disabled.get(projectId);
    if (!set) {
      set = new Set();
      this.disabled.set(projectId, set);
    }
    set.add(id);
    return this;
  }

  /** Re-enable a previously disabled provider for a project. */
  enable(id: string, projectId: string): this {
    this.disabled.get(projectId)?.delete(id);
    return this;
  }

  /** Snapshot for introspection / persistence. */
  snapshot(): ContextRegistrySnapshot {
    const disabled: Record<string, Record<string, boolean>> = {};
    for (const [projectId, set] of this.disabled) {
      const inner: Record<string, boolean> = {};
      for (const id of set) {
        inner[id] = true;
      }
      disabled[projectId] = inner;
    }
    return {
      providerIds: [...this.insertionOrder],
      disabled
    };
  }

  /**
   * Run every provider enabled for `projectId` under a single shared character
   * budget. The total budget is split equally (with remainder going to the
   * first providers); each provider collects against its share, and the final
   * concatenation is hard-capped at the total so an overshooting provider can
   * never exceed the budget.
   */
  async runAll(
    totalBudget: ContextBudget,
    projectId?: string
  ): Promise<RunAllResult> {
    const enabled = this.list().filter((p) => this.isEnabled(p.id, projectId));

    if (enabled.length === 0 || totalBudget.maxChars <= 0) {
      return { snippets: [], perProviderBudget: 0, enabledCount: enabled.length };
    }

    const perProviderBudget = Math.floor(totalBudget.maxChars / enabled.length);
    // First `remainder` providers get one extra character so the full budget is usable.
    const remainder = totalBudget.maxChars - perProviderBudget * enabled.length;

    const collected: ContextSnippet[] = [];
    for (let idx = 0; idx < enabled.length; idx += 1) {
      const provider = enabled[idx]!;
      const share: ContextBudget = {
        maxChars: perProviderBudget + (idx < remainder ? 1 : 0)
      };
      let snippets: readonly ContextSnippet[];
      try {
        snippets = await provider.collect(share);
      } catch {
        // A provider error never fails the turn; it just contributes nothing.
        snippets = [];
      }
      // Enforce the share structurally: a provider that ignores its budget
      // cannot take more than its share, so the sum across providers can never
      // exceed the total budget.
      for (const snippet of hardCap(snippets, share.maxChars)) {
        collected.push(snippet);
      }
    }

    return {
      snippets: collected,
      perProviderBudget,
      enabledCount: enabled.length
    };
  }
}

/**
 * Reduce an ordered snippet list so the sum of body lengths never exceeds
 * `maxChars`. Whole snippets are dropped from the tail once the cap is reached;
 * the final snippet is character-truncated only if it alone crosses the cap.
 */
export function hardCap(
  snippets: readonly ContextSnippet[],
  maxChars: number
): readonly ContextSnippet[] {
  if (maxChars <= 0) {
    return [];
  }
  const out: ContextSnippet[] = [];
  let used = 0;
  for (const snippet of snippets) {
    if (used >= maxChars) {
      break;
    }
    const remaining = maxChars - used;
    if (snippet.body.length <= remaining) {
      out.push(snippet);
      used += snippet.body.length;
    } else {
      out.push({ ...snippet, body: snippet.body.slice(0, remaining) });
      used = maxChars;
      break;
    }
  }
  return out;
}
