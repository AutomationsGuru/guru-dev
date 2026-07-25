/**
 * AgentMemoryScopeBound — per-agentId memory key namespacing with cross-agent
 * isolation (VISION §1 compounding + correct scoping).
 *
 * Multiple agents share one memory store but each owns a private namespace.
 * Keys are stored under `${agentId}::${key}`; the bound instance only ever
 * reads/writes its own prefix, so one agent can never read or write another
 * agent's keys. Cross-prefix access (a caller trying to pass another agent's
 * namespaced key directly) is rejected.
 *
 * The store is injectable so callers can bind an agentId to a real FileMemoryStore
 * (store.ts) or an isolated Map for tests; the scope-bound facade is the only
 * mutation surface an agent is handed. Minimal surface; follows the create*
 * factory + interface style from scopes.ts/store.ts.
 *
 * Hard limits preserved: no secret exposure (scoped keys), no destruction, no
 * cross-agent crossing — the bound is itself a structural enforcement of scope.
 */

const NAMESPACE_SEP = "::";

export interface NamespacedMemoryStore {
  /** Read the raw namespaced value (or `undefined`). */
  getRaw(namespacedKey: string): unknown;
  /** Write the raw namespaced value. */
  setRaw(namespacedKey: string, value: unknown): void;
}

export interface AgentMemoryScopeBound {
  /** Retrieve the value for `key` within this agentId's namespace only. */
  get(key: string): unknown;
  /** Store `value` under `key` within this agentId's namespace only. */
  set(key: string, value: unknown): void;
}

export interface AgentMemoryScopeBoundOptions {
  /**
   * Backing store for namespaced keys. Defaults to an isolated per-instance Map,
   * so two unbacked bounds do not share state unless an explicit store is passed.
   */
  readonly store?: NamespacedMemoryStore;
}

/** Default isolated backing: one Map per bound instance. */
function createIsolatedStore(): NamespacedMemoryStore {
  const map = new Map<string, unknown>();
  return {
    getRaw: (k) => map.get(k),
    setRaw: (k, v) => {
      map.set(k, v);
    }
  };
}

function namespacedKey(agentId: string, key: string): string {
  return `${agentId}${NAMESPACE_SEP}${key}`;
}

function isCrossAgentKey(agentId: string, key: string): boolean {
  if (!key.includes(NAMESPACE_SEP)) return false;
  return key.split(NAMESPACE_SEP)[0] !== agentId;
}

/**
 * Bind a memory store to a single agentId's namespace. All get/set are confined
 * to `${agentId}::${key}`; an explicit other-agent prefix in `key` is rejected.
 */
export function createAgentMemoryScopeBound(
  agentId: string,
  options: AgentMemoryScopeBoundOptions = {}
): AgentMemoryScopeBound {
  if (!agentId || agentId.length === 0) {
    throw new Error("agentId must be non-empty");
  }
  if (agentId.includes(NAMESPACE_SEP)) {
    throw new Error(`agentId must not contain the namespace separator "${NAMESPACE_SEP}"`);
  }

  const store = options.store ?? createIsolatedStore();

  return {
    get(key: string) {
      if (isCrossAgentKey(agentId, key)) {
        throw new Error(
          `Cross-agent access denied: agentId "${agentId}" cannot read a key scoped to another agent`
        );
      }
      return store.getRaw(namespacedKey(agentId, key));
    },
    set(key: string, value: unknown) {
      if (isCrossAgentKey(agentId, key)) {
        throw new Error(
          `Cross-agent access denied: agentId "${agentId}" cannot write a key scoped to another agent`
        );
      }
      store.setRaw(namespacedKey(agentId, key), value);
    }
  };
}
