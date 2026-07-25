/**
 * Social algorithm slot — IDEA-F526-SOCIAL-01 / R-SW-SOCIAL.
 *
 * Registry for named callable social algorithms. Algorithms register by id
 * and are invoked via run which returns a structured bag result.
 *
 * Callers register a named algorithm id with its callable implementation.
 * Unknown ids, empty ids, or unregistered calls fail closed (`ok: false`).
 *
 * Explicitly out of scope: swarm execution, model wiring, multi-tenant
 * concerns, and any core runtime edits. This is a pure registration seam.
 */

export type SocialAlgorithmId = string;

export interface SocialAlgorithm {
  readonly id: SocialAlgorithmId;
  readonly fn: (input?: unknown) => unknown;
}

const ALGORITHMS: Map<SocialAlgorithmId, SocialAlgorithm> = new Map();

const KNOWN_IDS = new Set<SocialAlgorithmId>();

/**
 * Register a named callable algorithm by id.
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` for duplicates/invalid.
 * Ids are trimmed; empty/whitespace ids are rejected (fail closed).
 */
export function registerSocialAlgorithm(
  id: string,
  fn: (input?: unknown) => unknown
): { ok: true } | { ok: false; reason: string } {
  if (typeof id !== "string") {
    return { ok: false, reason: "algorithm id is required" };
  }
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "algorithm id is required" };
  }
  if (typeof fn !== "function") {
    return { ok: false, reason: "callable fn is required" };
  }
  if (KNOWN_IDS.has(trimmed)) {
    return {
      ok: false,
      reason: `algorithm id "${trimmed}" already registered (fail closed)`
    };
  }
  const algo: SocialAlgorithm = Object.freeze({ id: trimmed, fn });
  ALGORITHMS.set(trimmed, algo);
  KNOWN_IDS.add(trimmed);
  return { ok: true };
}

/**
 * Run a registered algorithm by id. Returns structured bag on success:
 * `{ ok: true, bag: <result of fn> }`.
 * Unknown, empty, or unregistered ids return `{ ok: false, reason }` — never invent defaults.
 */
export function runSocialAlgorithm(
  id: string,
  input?: unknown
): { ok: true; bag: unknown } | { ok: false; reason: string } {
  if (typeof id !== "string") {
    return { ok: false, reason: "algorithm id is required" };
  }
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "algorithm id is required" };
  }
  if (!KNOWN_IDS.has(trimmed)) {
    return {
      ok: false,
      reason: `unknown social algorithm "${trimmed}" (fail closed)`
    };
  }
  const algo = ALGORITHMS.get(trimmed);
  if (!algo) {
    // Defensive: unreachable if KNOWN_IDS is consistent.
    return {
      ok: false,
      reason: `unknown social algorithm "${trimmed}" (fail closed)`
    };
  }
  try {
    const bag = algo.fn(input);
    return { ok: true, bag };
  } catch (err) {
    return {
      ok: false,
      reason: `algorithm "${trimmed}" threw: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
