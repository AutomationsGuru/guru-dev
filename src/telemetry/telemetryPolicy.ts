import { z } from "zod";

/**
 * Telemetry policy (IDEA-F12 / R-CR-TELE): phone-home paths are DEFAULT OFF.
 *
 * The harness performs zero telemetry unless the operator explicitly opts in
 * (`enabled: true`); absent config, `enabled: false`, and an unparsed default
 * all resolve to the same inert policy, and the emitter consults the policy on
 * every call so a default boot can never emit. Payloads that do flow under
 * explicit opt-in are sanitized structurally here — secret-shaped keys and
 * secret-shaped values are redacted before the transport sees them (hard limit
 * §3: no leaked secrets — enforced in code, not prose).
 *
 * Wire path (not yet connected): when a product surface emits telemetry it
 * should thread `telemetry` config into {@link createTelemetryEmitter} with a
 * real transport; the default export below keeps every surface inert until
 * that opt-in wiring lands.
 */

/** Key names whose values are never allowed into a telemetry payload. */
const SECRET_KEY_PATTERN = /(secret|password|passwd|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|session[-_]?key|passphrase)/i;

/** Value shapes that identify a secret even under an innocent key name. */
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/, // OpenAI / Anthropic-style API keys
  /\bghp_[A-Za-z0-9]{16,}\b/, // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{16,}\b/, // GitHub OAuth tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i, // Authorization headers
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ // JWTs
];

const REDACTED = "[redacted]";

/**
 * The telemetry config block. `enabled` defaults to **false** — a config file
 * that never mentions telemetry opts OUT. `endpoint` is optional and absent by
 * default: even an opted-in operator emits nothing until a destination is
 * wired. Strict so a misspelled key fails loudly instead of silently widening
 * the policy.
 */
export const TelemetryConfigSchema = z
  .object({
    /** Explicit opt-in is the ONLY way telemetry turns on. */
    enabled: z.boolean().default(false),
    /** Optional destination URL; null = no wire configured even when enabled. */
    endpoint: z.string().trim().url().nullable().default(null)
  })
  .strict();
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type TelemetryConfigInput = z.input<typeof TelemetryConfigSchema>;

/** The inert default: absent config resolves here and emits nothing. */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = TelemetryConfigSchema.parse({});

/** The single gate every emit path must consult. False unless explicit true. */
export function isTelemetryEnabled(config: TelemetryConfig): boolean {
  return config.enabled === true;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Structural scrubber: recursively redact secret-shaped keys and values from a
 * payload before it can reach a transport. Unknown values pass through; only
 * plain JSON-shaped data is expected here.
 */
export function sanitizeTelemetryPayload(value: unknown): unknown {
  if (typeof value === "string") {
    return isSecretValue(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTelemetryPayload(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : sanitizeTelemetryPayload(entry);
    }
    return out;
  }
  return value;
}

/** One telemetry event handed to the transport after policy + scrubbing. */
export interface TelemetryEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}

/**
 * Transport seam: the policy never does network I/O itself. A future wire path
 * injects the real sender (fetch to the configured endpoint); tests inject a
 * spy. The endpoint is passed through so the transport stays pure.
 */
export type TelemetryTransport = (event: TelemetryEvent, endpoint: string | null) => Promise<void>;

/**
 * Build the emit function for a resolved config. When the policy is off
 * (default), the returned function is a no-op — no event is built, no
 * transport is called, no network can happen. When explicitly enabled, the
 * payload is sanitized and handed to the injected transport; a transport
 * failure drops the event rather than crashing the session (telemetry must
 * never become a reliability dependency).
 */
export function createTelemetryEmitter(
  config: TelemetryConfig,
  options: { send?: TelemetryTransport; now?: () => Date } = {}
): (name: string, payload: Record<string, unknown>) => Promise<void> {
  if (!isTelemetryEnabled(config)) {
    return async () => {};
  }
  const now = options.now ?? (() => new Date());
  return async (name, payload) => {
    const event: TelemetryEvent = {
      name,
      payload: sanitizeTelemetryPayload(payload) as Record<string, unknown>,
      timestamp: now().toISOString()
    };
    try {
      await options.send?.(event, config.endpoint);
    } catch {
      // Telemetry is best-effort: a failed send must never break the session.
    }
  };
}
