/**
 * Secret-safety core (FR-21, generalized 2026-07-04 from src/tui/state.ts).
 *
 * Two complementary guarantees, both value-free by construction:
 *
 * 1. SHAPE patterns — token-shaped strings (API keys, JWTs, private keys, ...)
 *    are detected in metadata/error surfaces regardless of where they came from.
 * 2. VALUE registry — every credential value the harness RESOLVES at runtime is
 *    registered here (value kept in process memory only) so any printable path
 *    (errors, transcripts, logs) can redact the exact value even when it does
 *    not match a known shape.
 *
 * The registry never persists, never enumerates, and never exposes values; its
 * only consumer is `scrubSecretValues`, which replaces them with a placeholder.
 */

export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/i, // OpenAI-style
  /sk-ant-[A-Za-z0-9_-]{16,}/i, // Anthropic
  /xox[baprs]-[A-Za-z0-9-]{10,}/i, // Slack
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/i, // GitHub PAT
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /ya29\.[A-Za-z0-9_-]{16,}/, // Google OAuth
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i, // user:pass@host connection string
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /glpat-[A-Za-z0-9_-]{20,}/, // GitLab PAT
  /npm_[A-Za-z0-9]{36}/ // npm token
];

/** Names parallel to SECRET_VALUE_PATTERNS — for the secret_sanitized event (never a value). */
export const SECRET_PATTERN_NAMES: readonly string[] = [
  "openai-key",
  "anthropic-key",
  "slack-token",
  "github-token",
  "github-pat",
  "aws-access-key",
  "google-oauth",
  "jwt",
  "private-key",
  "bearer-token",
  "basic-auth-url",
  "google-api-key",
  "gitlab-pat",
  "npm-token"
];

const REDACTED_VALUE = "[redacted:credential]";
const REDACTED_SHAPE = "[redacted:secret-shape]";

/** Minimum length before a value is worth registering (avoids scrubbing noise). */
const MIN_REGISTER_LENGTH = 8;

const registeredValues = new Set<string>();

/** Observers notified when a scrub fires — pattern NAMES only, never the value (§17.9). */
type SanitizeListener = (patterns: readonly string[]) => void;
const sanitizeListeners = new Set<SanitizeListener>();

/** Subscribe to sanitization events (the secret_sanitized signal). Returns an unsubscribe. */
export function onSecretSanitized(listener: SanitizeListener): () => void {
  sanitizeListeners.add(listener);
  return () => sanitizeListeners.delete(listener);
}

/** Fire the sanitization observers with the matched pattern names (never values). */
export function notifySecretSanitized(patterns: readonly string[]): void {
  if (patterns.length === 0) {
    return;
  }
  for (const listener of sanitizeListeners) {
    listener(patterns);
  }
}

/**
 * Registers a resolved credential value for exact-value redaction. The value
 * lives only in process memory; call sites register at resolve time so every
 * downstream printable surface can scrub it.
 */
export function registerSecretValue(value: string | undefined): void {
  if (typeof value === "string" && value.length >= MIN_REGISTER_LENGTH) {
    registeredValues.add(value);
  }
}

/** Test-only: clears the in-memory registry. */
export function clearRegisteredSecretValues(): void {
  registeredValues.clear();
}

/**
 * Replaces every registered credential value and every token-shaped substring
 * with a redaction placeholder. Safe on arbitrary text; idempotent.
 */
export function scrubSecretValues(text: string): string {
  if (text.length === 0) {
    return text;
  }
  let out = text;
  for (const value of registeredValues) {
    if (out.includes(value)) {
      out = out.split(value).join(REDACTED_VALUE);
    }
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    out = out.replace(global, REDACTED_SHAPE);
  }
  return out;
}

/**
 * Same scrub as {@link scrubSecretValues}, but also returns the NAMES of the
 * patterns (or `registered-value`) that fired — for the secret_sanitized event.
 * The matched value itself is NEVER returned; only which kind of secret matched.
 */
export function scrubSecretValuesReport(text: string): { readonly text: string; readonly matched: readonly string[] } {
  if (text.length === 0) {
    return { text, matched: [] };
  }
  const matched = new Set<string>();
  let out = text;
  for (const value of registeredValues) {
    if (out.includes(value)) {
      out = out.split(value).join(REDACTED_VALUE);
      matched.add("registered-value");
    }
  }
  SECRET_VALUE_PATTERNS.forEach((pattern, index) => {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    const before = out;
    out = out.replace(global, REDACTED_SHAPE);
    if (out !== before) {
      matched.add(SECRET_PATTERN_NAMES[index] ?? "secret-shape");
    }
  });
  return { text: out, matched: [...matched] };
}

/**
 * Scrubs ONLY registered resolved-credential values (no shape patterns).
 * Used on conversation transcripts, where operators may legitimately discuss
 * token formats — but a value the harness itself resolved must never persist.
 */
export function scrubRegisteredSecretValues(text: string): string {
  if (text.length === 0 || registeredValues.size === 0) {
    return text;
  }
  let out = text;
  for (const value of registeredValues) {
    if (out.includes(value)) {
      out = out.split(value).join(REDACTED_VALUE);
    }
  }
  return out;
}

/** True when the text contains a token-shaped substring or a registered value. */
export function containsSecretValue(text: string): boolean {
  for (const value of registeredValues) {
    if (text.includes(value)) {
      return true;
    }
  }
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Asserts that none of the given metadata strings carry a secret value or a
 * token-shaped substring. Throws (value-free) on the first suspected leak.
 */
export function assertSecretSafeStrings(haystack: readonly string[], context: string): void {
  for (const slice of haystack) {
    if (slice.length === 0) {
      continue;
    }
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(slice)) {
        throw new Error(`${context} failed secret-safety scan: pattern ${pattern.source} matched.`);
      }
    }
    for (const value of registeredValues) {
      if (slice.includes(value)) {
        throw new Error(`${context} failed secret-safety scan: a resolved credential value was present.`);
      }
    }
  }
}
