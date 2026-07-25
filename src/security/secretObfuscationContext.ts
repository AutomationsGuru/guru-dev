/**
 * Secret obfuscation in context (IDEA-F183-SECRET-OBFUSC-01 / R-LT-SECRET).
 *
 * Purpose: redact known secret patterns and resolved env values from arbitrary
 * strings BEFORE they are injected into model context. This is the context-side
 * complement to the output/compaction scrubbers in `src/safety/secretSafety.ts`
 * — that module scrubs tool OUTPUT and disk-bound transcripts; this one scrubs
 * operator-supplied context strings (env dumps, config excerpts, pasted logs)
 * before the model ever sees them.
 *
 * Hard guarantee (§3.3 no leaked secrets): no secret VALUE ever leaves this
 * module. Inputs are replaced in place with {@link OBFUSCATED_PLACEHOLDER}; the
 * optional report returns only the KIND of secret that matched (a name like
 * "openai-key" or "caller-secret"), never the value. All redaction is structural
 * — in a code path, not in prompt text.
 *
 * Two redaction sources:
 *   1. KNOWN SHAPES — the {@link SECRET_VALUE_PATTERNS} registry re-exported from
 *      secretSafety (OpenAI/Anthropic/GitHub/AWS/Stripe/JWT/private-key/...).
 *   2. CALLER SECRETS — the `secrets[]` argument: exact string values and/or
 *      RegExp patterns the operator resolved (env values, connection strings).
 *
 * Everything runs on bounded, linear-safe scans; this runs on potentially large
 * context blocks and must not backtrack catastrophically (see secretSafety).
 */

import {
  SECRET_VALUE_PATTERNS,
  SECRET_PATTERN_NAMES
} from "../safety/secretSafety.js";

/** Placeholder substituted for every redacted secret. Value-free by design. */
export const OBFUSCATED_PLACEHOLDER = "[redacted:secret]";

/** Minimum length for a caller-provided string secret — shorter is scrub noise. */
const MIN_SECRET_LENGTH = 8;

/**
 * A caller-provided secret to redact. A bare string is treated as an exact value;
 * a RegExp is applied as-is (use anchored/bounded sources to stay linear-safe).
 */
export type Secret = string | RegExp;

export interface ObfuscateOptions {
  /** Caller-resolved secret values and/or patterns to redact in addition to shapes. */
  secrets?: readonly Secret[];
  /** When true, the return value carries the KINDS matched (never values). */
  report?: boolean;
}

export interface ObfuscateReport {
  /** The redacted text (same shape as input). */
  readonly text: string;
  /** Kinds of secrets that fired (e.g. "openai-key", "caller-secret"). Never values. */
  readonly matched: readonly string[];
}

/**
 * Redact every known secret shape and every caller-provided secret from `text`
 * before context inject. Value-free: the original secret is replaced with
 * {@link OBFUSCATED_PLACEHOLDER} and never returned, logged, or persisted.
 *
 * @param text the context string to scrub
 * @param options.secrets caller-resolved values/patterns to also redact
 * @returns the redacted string (or an {@link ObfuscateReport} if `report:true`)
 */
export function obfuscate(text: string): string;
export function obfuscate(text: string, options: ObfuscateOptions & { report: true }): ObfuscateReport;
export function obfuscate(text: string, options?: ObfuscateOptions): string | ObfuscateReport;
export function obfuscate(
  text: string,
  options: ObfuscateOptions = {}
): string | ObfuscateReport {
  if (text.length === 0) {
    return options.report ? { text, matched: [] } : text;
  }

  const matched = options.report ? new Set<string>() : null;
  let out = text;

  // 1. Caller-provided secrets first: exact values then RegExp patterns.
  //    A literal split/join avoids any regex cost on plain values and is linear.
  for (const secret of options.secrets ?? []) {
    if (typeof secret === "string") {
      if (secret.length < MIN_SECRET_LENGTH) {
        continue;
      }
      if (out.includes(secret)) {
        out = out.split(secret).join(OBFUSCATED_PLACEHOLDER);
        matched?.add("caller-secret");
      }
    } else if (secret instanceof RegExp) {
      const global = secret.global ? secret : new RegExp(secret.source, `${secret.flags}g`);
      if (global.test(out)) {
        // reset lastIndex after the .test() probe on a global regex.
        global.lastIndex = 0;
        out = out.replace(global, OBFUSCATED_PLACEHOLDER);
        matched?.add("caller-pattern");
      }
    }
  }

  // 2. Known token shapes (OpenAI/Anthropic/GitHub/AWS/Stripe/JWT/...).
  SECRET_VALUE_PATTERNS.forEach((pattern, index) => {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    if (global.test(out)) {
      global.lastIndex = 0;
      out = out.replace(global, OBFUSCATED_PLACEHOLDER);
      matched?.add(SECRET_PATTERN_NAMES[index] ?? "secret-shape");
    }
  });

  if (options.report) {
    return { text: out, matched: matched ? [...matched] : [] };
  }
  return out;
}

/**
 * Test-only: present for API symmetry with secretSafety's registry clear. This
 * module keeps NO cross-call state (secrets are passed per-call), so this is a
 * no-op kept so test teardown has a stable cleanup hook.
 */
export function clearObfuscationState(): void {
  /* stateless — nothing to clear */
}
