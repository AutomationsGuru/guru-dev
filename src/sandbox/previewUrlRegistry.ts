/**
 * Preview URL Tunnel Registry
 *
 * Maps (boxId + port) → local preview URL string.
 * Enforces conflict detection: duplicate port per boxId is rejected.
 *
 * register/get/release lifecycle for sandbox preview tunnels.
 */

const tunnels = new Map<string, string>();

function key(boxId: string, port: number): string {
  return `${boxId}:${port}`;
}

/**
 * Register a preview tunnel URL for a given boxId and port.
 * @throws Error if the (boxId, port) pair is already registered (conflict).
 */
export function register(boxId: string, port: number, previewUrl: string): void {
  const k = key(boxId, port);
  if (tunnels.has(k)) {
    throw new Error(`Preview URL conflict: boxId=${boxId} port=${port} already in use`);
  }
  tunnels.set(k, previewUrl);
}

/**
 * Retrieve the registered preview URL for a boxId+port pair.
 * @returns The URL string or undefined if not registered.
 */
export function get(boxId: string, port: number): string | undefined {
  return tunnels.get(key(boxId, port));
}

/**
 * Release/unregister a preview tunnel for a boxId+port pair.
 * Idempotent: no-op if not present.
 */
export function release(boxId: string, port: number): void {
  tunnels.delete(key(boxId, port));
}

/**
 * Clear all registered tunnels. Intended for test isolation only.
 */
export function clear(): void {
  tunnels.clear();
}
