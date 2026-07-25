/**
 * Consensus verification helper for review scoring (IDEA-F540-CONSENSUS-01).
 *
 * Pure function: no side effects, no I/O, deterministic given inputs.
 * Matches surrounding review module style (gates.ts, nativeCriticPanel.ts):
 * explicit types, high comment density, JSDoc, readonly inputs for purity.
 */

/**
 * Returns true if and only if at least `n` scores in the array are
 * greater than or equal to the provided `threshold`.
 *
 * Edge behavior:
 * - n <= 0 always returns true (vacuously satisfied).
 * - empty array: true only when n <= 0.
 * - n > scores.length: false unless n <= 0.
 * - NaN scores are treated as failing the threshold (never count toward N).
 *
 * @param scores - Array of numeric scores (e.g. critic confidence values in [0,1]).
 * @param n - Minimum number of scores that must meet or exceed threshold.
 * @param threshold - The cutoff value (inclusive).
 * @returns True when the consensus condition holds.
 */
export function pass(
  scores: readonly number[],
  n: number,
  threshold: number
): boolean {
  // Guard: non-positive n is vacuously true (no requirement to satisfy).
  if (n <= 0) {
    return true;
  }

  // Count how many scores meet the threshold. Filter NaN explicitly so they
  // never contribute to consensus (defensive; callers should sanitize but we
  // remain robust).
  const qualifying = scores.filter((score) => {
    // NaN comparisons are always false, but be explicit for readability.
    return Number.isFinite(score) && score >= threshold;
  }).length;

  return qualifying >= n;
}
