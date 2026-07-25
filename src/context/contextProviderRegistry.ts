/**
 * IDEA-F255-CTX-PROV-REG-01 — context provider registry.
 *
 * A named registry of *context providers*. Each provider contributes context
 * snippets (free-form bodies, e.g. repo state, role loadout, recent memory,
 * task framing) that are concatenated before a model call so the model starts
 * the turn already oriented.
 *
 * Design intent (see GuruHarness VISION §1):
 * - Breadth lives at the provider layer, not in core. The registry is the one
 *   frozen extension seam for "things that should appear in the model's
 *   pre-turn context"; new sources register here and never edit the model
 *   loop directly.
 * - Collection is deterministic: providers run in registration order and their
 *   snippets concatenate in that order, so callers can stage system → role →
 *   task context predictably.
 * - Collection is resilient: a single failing provider is isolated (its
 *   snippet is dropped and reported) rather than poisoning the whole turn.
 *
 * This module owns only registration and collection; it does not decide where
 * collected snippets are injected into a prompt. That wiring belongs to the
 * model/turn layer.
 */

/**
 * A single piece of context contributed by a provider.
 *
 * `name` scopes the snippet within its provider (e.g. "cwd", "git-branch");
 * `body` is the free-form text to surface before the model call.
 */
export interface ContextSnippet {
  readonly name: string;
  readonly body: string;
}

/**
 * Input handed to every provider at collection time. All fields are optional
 * so a provider can opt into the signals it cares about without forcing every
 * other provider to supply them.
 */
export interface ContextCollectionContext {
  /** Working directory of the active project, when known. */
  readonly cwd?: string;
  /** The operator's raw request/goal for the turn, when available. */
  readonly goal?: string;
  /** Free-form metadata the caller wants to share with providers. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A named source of pre-turn context. Providers register under a stable name
 * and contribute zero or more snippets each collection. A thrown error is
 * treated as "this provider contributed nothing this turn" and reported, not
 * raised.
 */
export interface ContextProvider {
  /** Stable, unique identifier for this provider (e.g. "repo", "role"). */
  readonly name: string;
  /** Human-readable label shown in diagnostics. Optional. */
  readonly label?: string;
  /**
   * Contribute snippets for this turn. Must be idempotent and side-effect free
   * relative to the model call; throwing is permitted and is isolated.
   */
  collect(context: ContextCollectionContext): Promise<readonly ContextSnippet[]> | readonly ContextSnippet[];
}

/** A provider failure captured during collection (never raised to the caller). */
export interface ContextCollectionError {
  readonly providerName: string;
  readonly message: string;
}

/** The result of running every registered provider once. */
export interface ContextCollectionResult {
  /** Snippets from all providers, concatenated in registration order. */
  readonly snippets: readonly ContextSnippet[];
  /** Providers that threw during collection, in the order they failed. */
  readonly errors: readonly ContextCollectionError[];
}

export interface ContextProviderRegistry {
  /** Register a named provider. Throws on a duplicate name. */
  register(provider: ContextProvider): void;
  /** Look up a provider by name. */
  find(name: string): ContextProvider | undefined;
  /** All registered providers in registration order. */
  list(): readonly ContextProvider[];
  /** Run every registered provider once and concatenate their snippets. */
  collect(context?: ContextCollectionContext): Promise<ContextCollectionResult>;
}

export function createContextProviderRegistry(
  initial: readonly ContextProvider[] = []
): ContextProviderRegistry {
  const providers = new Map<string, ContextProvider>();
  const order: string[] = [];

  const registry: ContextProviderRegistry = {
    register(provider) {
      if (providers.has(provider.name)) {
        throw new Error(`Context provider already registered: ${provider.name}`);
      }
      providers.set(provider.name, provider);
      order.push(provider.name);
    },
    find(name) {
      return providers.get(name);
    },
    list() {
      return order.map((name) => providers.get(name)).filter((p): p is ContextProvider => p !== undefined);
    },
    async collect(context: ContextCollectionContext = {}) {
      const snippets: ContextSnippet[] = [];
      const errors: ContextCollectionError[] = [];

      for (const name of order) {
        const provider = providers.get(name);
        if (!provider) {
          continue;
        }
        try {
          const contributed = await provider.collect(context);
          for (const snippet of contributed) {
            snippets.push(snippet);
          }
        } catch (error) {
          errors.push({
            providerName: provider.name,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return { snippets, errors };
    }
  };

  for (const provider of initial) {
    registry.register(provider);
  }

  return registry;
}
