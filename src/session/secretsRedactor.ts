/**
 * Session secrets redactor — a thin session/export adapter over the canonical
 * safety-layer scrubbers. Every session-transcript and tool-output surface that
 * needs secret redaction goes through this adapter, which delegates entirely
 * to the structural scrubbers in src/safety/. It never creates its own regex
 * policy; the canonical patterns, value registry, and deep-walk are the single
 * source of truth (Constitution §3.3 — No leaked secrets).
 *
 * IDEA-F286-SECRET-REDACT-01.
 */

import { sanitizeToolOutput } from "../safety/outputSanitizer.js";
import {
  scrubRegisteredSecretValues,
  scrubSecretValues,
  scrubSecretValuesReport
} from "../safety/secretSafety.js";

/**
 * Redact plain text for session export/display.
 * Applies the full shape-pattern + registered-value + assignment scrubber.
 * Idempotent — safe to call on already-redacted text.
 */
export function redact(text: string): string {
  return scrubSecretValues(text);
}

/**
 * Redact text AND report which pattern kinds matched (for audit surfaces).
 * The matched list contains pattern NAMES only (e.g. "openai-key", "registered-value",
 * "secret-assignment") — never the secret value itself.
 */
export function redactReport(text: string): { readonly text: string; readonly matched: readonly string[] } {
  return scrubSecretValuesReport(text);
}

/**
 * Redact only registered resolved-credential values, leaving shape-matched
 * substrings visible. For conversation transcripts where operators may
 * legitimately discuss token formats, but a value the harness resolved itself
 * must never persist.
 */
export function redactTranscript(text: string): string {
  return scrubRegisteredSecretValues(text);
}

/**
 * Deep-walk a tool-output object and redact every string field through the
 * shape + registered-value scrubber. Objects are walked recursively (max
 * depth 12); primitives pass through unchanged. Returns the SAME reference
 * when nothing needed scrubbing (no churn for clean output).
 *
 * This is the session-facing alias for sanitizeToolOutput, wired at the
 * session export / done-packet boundary so every exported tool result is
 * scrubbed by construction — structural enforcement, not prompt prose.
 */
export function redactToolOutput<T>(output: T): T {
  return sanitizeToolOutput(output);
}
