/**
 * Tool-result redaction pass — a pure, stateless text filter for removing
 * secret-shaped substrings from tool output before it enters the transcript.
 *
 * This is the "tool result → transcript" boundary filter. It is intentionally
 * simpler than `scrubSecretValues` / `scrubSecretValuesReport`: no stateful
 * registered-value registry, no event emission, no deep-object walk. It takes
 * text and patterns and returns text. The patterns are the same well-tested
 * `SECRET_VALUE_PATTERNS` from `src/safety/secretSafety.ts`.
 *
 * Why a separate module:
 *  - The full scrubber also tracks registered values and fires
 *    `secret_sanitized` events — those are not needed at the pure-text
 *    transcript boundary.
 *  - This is a composable building block: callers who already handle the
 *    registered-value / event surface (e.g. the output sanitizer) can pass
 *    `redact` for the narrower text-only case.
 *  - It is guaranteed pure — idempotent, no side effects, no state mutation.
 */

import { SECRET_VALUE_PATTERNS } from "../safety/secretSafety.js";

/** The placeholder string substituted for each redacted match. */
export const REDACT_PLACEHOLDER = "[redacted]";

/**
 * The default set of secret-shape patterns used when the caller does not
 * provide explicit patterns. These are the same `SECRET_VALUE_PATTERNS` used
 * by the full `scrubSecretValues` / `scrubSecretValuesReport` pipeline.
 */
export const DEFAULT_REDACT_PATTERNS: readonly RegExp[] = SECRET_VALUE_PATTERNS;

/**
 * Redact secret-shaped substrings from `text`.
 *
 * - If `patterns` is provided, only those patterns are applied.
 * - If `patterns` is omitted, {@link DEFAULT_REDACT_PATTERNS} is used.
 * - Every matched substring is replaced with {@link REDACT_PLACEHOLDER}.
 * - The function is **pure**: no side effects, no state mutation, no event
 *   emission. It is safe to call from any context.
 * - Idempotent: `redact(redact(text)) === redact(text)`.
 * - Returns `text` unchanged when no patterns match.
 * - Returns empty string when `text` is empty (avoids regex overhead).
 *
 * @param text  Arbitrary text to scan.
 * @param patterns  Optional override patterns; defaults to `SECRET_VALUE_PATTERNS`.
 * @returns The text with every matching substring replaced with `[redacted]`.
 */
export function redact(text: string, patterns?: readonly RegExp[]): string {
  if (text.length === 0) {
    return text;
  }
  const effectivePatterns = patterns ?? DEFAULT_REDACT_PATTERNS;
  let out = text;
  for (const pattern of effectivePatterns) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    );
    out = out.replace(global, REDACT_PLACEHOLDER);
  }
  return out;
}