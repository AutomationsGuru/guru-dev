// A simple in-memory store for workflow artifacts.
const artifactStore = new Map<string, unknown>();

/**
 * Puts an artifact into the store.
 * @param name The name of the artifact.
 * @param value The value of the artifact.
 */
export function put(name: string, value: unknown): void {
  artifactStore.set(name, value);
}

/**
 * Gets an artifact from the store.
 * @param name The name of the artifact.
 * @returns The value of the artifact, or undefined if it doesn't exist.
 */
export function get<T>(name: string): T | undefined {
  const value = artifactStore.get(name);
  if (value === undefined) {
    return undefined;
  }
  return value as T;
}
