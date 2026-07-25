/**
 * storeBackendPluggable — pluggable get/set/delete backend seam for agent
 * state (IDEA-F240-STORE-BACKEND-01, composes F174 identity + F197 local
 * store, 2026-07-19).
 *
 * The harness never hardcodes *where* agent state lives: state holders depend
 * on the `MemoryStoreBackend` interface, and the concrete backend is chosen at
 * the seam. `createMemoryStoreBackend` is the zero-dependency in-memory map
 * implementation — the bare-boot default. Heavier backends (file, Postgres,
 * etc.) attach later as explicit, replaceable implementations of the same
 * three verbs; nothing in core needs to change when they do.
 */

export interface MemoryStoreBackend {
  /** Read a value; `undefined` when the key is absent. */
  get(key: string): string | undefined;
  /** Write (or overwrite) a value. */
  set(key: string, value: string): void;
  /** Remove a key; `true` when it existed, `false` otherwise. */
  delete(key: string): boolean;
}

/**
 * In-memory map backend — the bare-boot default. State survives only for the
 * life of the instance, which is exactly right for tests, ephemeral agent
 * state, and as the reference implementation for future backends. A seed map
 * may be passed; it is copied so later mutation of the seed cannot leak in.
 */
export function createMemoryStoreBackend(seed?: ReadonlyMap<string, string>): MemoryStoreBackend {
  const data = new Map<string, string>(seed);
  return {
    get(key) {
      return data.get(key);
    },
    set(key, value) {
      data.set(key, value);
    },
    delete(key) {
      return data.delete(key);
    }
  };
}
