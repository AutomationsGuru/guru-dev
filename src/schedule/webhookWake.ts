import { createHmac, timingSafeEqual } from "node:crypto";

import {
  DEFAULT_WEBHOOK_WAKE_CONFIG,
  WebhookWakeConfig,
  WebhookWakeConfigSchema,
  WebhookWakeInputSchema,
  WebhookWakeJob,
  WebhookWakeJobSchema
} from "./webhookWakeSchema.js";

/**
 * Constant-time HMAC SHA-256 signature check.
 *
 * Uses `timingSafeEqual` so an attacker cannot guess the secret byte-by-byte
 * through timing side channels.  Rejects early when the buffers differ in
 * length (no comparison ran, so no timing information is leaked).
 */
export function validateSignature(body: string, signature: string, secret: string): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(body, "utf8");
  const expected = hmac.digest();

  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  if (expected.length !== actual.length) {
    // Different length → definitely wrong; safe to bail early because
    // no comparison was performed and the attacker learns only the
    // (public) digest length.
    return false;
  }

  return timingSafeEqual(expected, actual);
}

export interface WebhookWakeSuccess {
  readonly job: WebhookWakeJob;
}

export interface WebhookWakeError {
  readonly error: string;
  readonly status: number;
}

export type WebhookWakeResult = WebhookWakeSuccess | WebhookWakeError;

/**
 * Handle an inbound webhook wake request.
 *
 * Steps (order matters — fail-closed):
 * 1. Config gate: reject if disabled.
 * 2. Secret gate: reject if the env var is missing.
 * 3. Signature gate: constant-time HMAC SHA-256 verify; reject on mismatch.
 * 4. Parse & validate the JSON body against the input schema.
 * 5. Produce a {@link WebhookWakeJob} for the fleet/schedule consumer.
 *
 * Loopback-only by design — this is a stub, not a public internet listener.
 */
export function handleWebhookWake(
  rawBody: string,
  signatureHeader: string,
  config?: WebhookWakeConfig
): WebhookWakeResult {
  const cfg = WebhookWakeConfigSchema.parse(config ?? DEFAULT_WEBHOOK_WAKE_CONFIG);

  if (!cfg.enabled) {
    return { error: "webhook wake is disabled", status: 503 };
  }

  const secret = process.env[cfg.secretEnvVar];
  if (!secret || secret.length === 0) {
    // Secret presence is reported by env-var name only — the value is never
    // logged, printed, or exposed (Hard Limit §3.3).
    return { error: `webhook secret not configured (env: ${cfg.secretEnvVar})`, status: 500 };
  }

  if (!validateSignature(rawBody, signatureHeader, secret)) {
    return { error: "invalid signature", status: 401 };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return { error: "invalid JSON body", status: 400 };
  }

  const parsed = WebhookWakeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `invalid payload: ${parsed.error.message}`, status: 400 };
  }

  const job: WebhookWakeJob = {
    objectiveId: parsed.data.objectiveId,
    receivedAt: new Date().toISOString(),
    source: "webhook"
  };

  // Redundant structural validation — belt and suspenders.
  const validated = WebhookWakeJobSchema.safeParse(job);
  if (!validated.success) {
    return { error: `internal: produced invalid job: ${validated.error.message}`, status: 500 };
  }

  return { job: validated.data };
}
