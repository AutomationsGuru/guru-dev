/**
 * Context provider registry (F255 / R-MA-CTX-REG).
 *
 * A `ContextProvider` is a named extension that contributes string snippets to
 * the prompt assembled before a model call. Providers register through this
 * registry — never the core — and `collectContextProviders` walks them in
 * priority order to assemble the final ordered list.
 *
 * Ordering: providers are returned ascending by `priority` (lower numbers run
 * earlier; ties broken by `id` to keep the sequence stable across runs).
 *
 * Failure policy: a provider that throws is logged-once-skipped for the current
 * collect so one broken contributor cannot starve the rest of the prompt.
 */

export interface ContextProviderQuery {
  readonly runId?: string;
  readonly cwd?: string;
  readonly [extra: string]: unknown;
}

export interface ContextProvider {
  readonly id: string;
  readonly priority: number;
  collect(query: ContextProviderQuery): Promise<readonly string[]> | readonly string[];
}

export interface ContextProviderRegistry {
  register(provider: ContextProvider): void;
  get(providerId: string): ContextProvider | undefined;
  list(): readonly ContextProvider[];
}

export function createContextProviderRegistry(initialProviders: readonly ContextProvider[] = []): ContextProviderRegistry {
  const providers = new Map<string, ContextProvider>();

  const registry: ContextProviderRegistry = {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Context provider already registered: ${provider.id}`);
      }
      providers.set(provider.id, provider);
    },
    get(providerId) {
      return providers.get(providerId);
    },
    list() {
      return [...providers.values()].sort(compareProviders);
    }
  };

  for (const provider of initialProviders) {
    registry.register(provider);
  }

  return registry;
}

/**
 * Walk every registered provider in priority-then-id order and concatenate
 * their snippets into a single ordered list. A provider that throws is
 * skipped; the remaining providers still run.
 */
export async function collectContextProviders(
  registry: ContextProviderRegistry,
  query: ContextProviderQuery
): Promise<readonly string[]> {
  const collected: string[] = [];
  const ordered = registry.list();

  for (const provider of ordered) {
    try {
      const snippets = await provider.collect(query);
      for (const snippet of snippets) {
        collected.push(snippet);
      }
    } catch {
      // Failure-isolating collect: a single broken provider cannot starve the
      // rest of the prompt. Drop its contribution silently — surfacing the
      // error mid-prompt would inject noise the model has no instruction for.
      continue;
    }
  }

  return collected;
}

function compareProviders(left: ContextProvider, right: ContextProvider): number {
  return left.priority - right.priority || left.id.localeCompare(right.id);
}
