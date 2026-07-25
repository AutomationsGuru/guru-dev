/**
 * Removes credential-shaped environment names before sandbox creation payloads
 * cross the host-to-box boundary. Values are intentionally never inspected.
 */
const SECRET_ENV_KEY = /(?:api[_-]?key|token)/iu;

/** Return a copy of env without API-key or token-shaped entries. */
export function scrubEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV_KEY.test(key)));
}
