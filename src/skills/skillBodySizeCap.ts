/**
 * Skill body size cap enforcer (IDEA-F412-8KB-01).
 *
 * A lightweight guard that checks whether a skill body's byte length falls
 * within a configured ceiling.  Intended to be called before a skill is
 * activated so that oversized bodies are caught early — keeping the kernel
 * small and the harness lightweight (§1.2 of the product vision).
 *
 * This module is a pure function; it owns no state, does no I/O, and has no
 * external dependencies.  It enforces the cap structurally (in code) rather
 * than relying on prose or prompts (§3 / prompt-rule drift).
 */

/**
 * Returns `true` when `body` byte length is within `maxBytes` (inclusive),
 * meaning the skill may be activated.
 *
 * @param body  The skill body text to measure.
 * @param maxBytes  The ceiling in bytes (must be a non-negative integer).
 * @returns `true` when `byteLength(body) <= maxBytes`.
 *
 * @throws {TypeError} when `body` is not a string.
 * @throws {RangeError} when `maxBytes` is not a non-negative safe integer.
 */
export function mayActivate(body: string, maxBytes: number): boolean {
  if (typeof body !== "string") {
    throw new TypeError("body must be a string");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  const byteLength = new TextEncoder().encode(body).length;
  return byteLength <= maxBytes;
}
