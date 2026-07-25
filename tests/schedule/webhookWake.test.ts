import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleWebhookWake, validateSignature } from '../../src/schedule/webhookWake.js';
import {
  WebhookWakeConfigSchema,
  WebhookWakeInputSchema,
  WebhookWakeJobSchema
} from '../../src/schedule/webhookWakeSchema.js';

const TEST_SECRET = "test-hmac-secret-k4";
const TEST_ENV_VAR = "GURUHARNESS_WEBHOOK_SECRET";

function sign(body: string, secret: string = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const VALID_BODY = JSON.stringify({ objectiveId: "obj-42" });

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------
describe("WebhookWakeInputSchema", () => {
  it("accepts a valid input with objectiveId", () => {
    const parsed = WebhookWakeInputSchema.parse({ objectiveId: "obj-1" });
    expect(parsed.objectiveId).toBe("obj-1");
  });

  it("rejects missing objectiveId", () => {
    expect(() => WebhookWakeInputSchema.parse({})).toThrow();
  });

  it("rejects empty objectiveId", () => {
    expect(() => WebhookWakeInputSchema.parse({ objectiveId: "" })).toThrow();
    expect(() => WebhookWakeInputSchema.parse({ objectiveId: "  " })).toThrow();
  });

  it("rejects extra unknown fields (strict)", () => {
    expect(() => WebhookWakeInputSchema.parse({ objectiveId: "x", extra: 1 })).toThrow();
  });

  it("rejects non-string objectiveId", () => {
    expect(() => WebhookWakeInputSchema.parse({ objectiveId: 123 })).toThrow();
  });
});

describe("WebhookWakeJobSchema", () => {
  it("accepts a valid job", () => {
    const job = WebhookWakeJobSchema.parse({
      objectiveId: "obj-1",
      receivedAt: "2026-07-19T00:00:00.000Z",
      source: "webhook"
    });
    expect(job.objectiveId).toBe("obj-1");
    expect(job.source).toBe("webhook");
  });

  it("rejects a job with wrong source literal", () => {
    expect(() =>
      WebhookWakeJobSchema.parse({
        objectiveId: "obj-1",
        receivedAt: "2026-07-19T00:00:00.000Z",
        source: "email"
      })
    ).toThrow();
  });

  it("rejects a non-datetime receivedAt", () => {
    expect(() =>
      WebhookWakeJobSchema.parse({
        objectiveId: "obj-1",
        receivedAt: "not-a-date",
        source: "webhook"
      })
    ).toThrow();
  });
});

describe("WebhookWakeConfigSchema", () => {
  it("defaults to disabled", () => {
    const cfg = WebhookWakeConfigSchema.parse({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.secretEnvVar).toBe("GURUHARNESS_WEBHOOK_SECRET");
  });

  it("accepts explicit enabled and custom env var", () => {
    const cfg = WebhookWakeConfigSchema.parse({ enabled: true, secretEnvVar: "MY_SECRET" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.secretEnvVar).toBe("MY_SECRET");
  });

  it("rejects invalid env var name (lowercase)", () => {
    expect(() => WebhookWakeConfigSchema.parse({ secretEnvVar: "my_secret" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Signature validation (unit)
// ---------------------------------------------------------------------------
describe("validateSignature", () => {
  it("returns true for a correct signature", () => {
    const sig = sign(VALID_BODY);
    expect(validateSignature(VALID_BODY, sig, TEST_SECRET)).toBe(true);
  });

  it("returns false for a signature made with a different secret", () => {
    const sig = sign(VALID_BODY, "wrong-secret");
    expect(validateSignature(VALID_BODY, sig, TEST_SECRET)).toBe(false);
  });

  it("returns false for a tampered body", () => {
    const sig = sign(VALID_BODY);
    expect(validateSignature('{"objectiveId":"obj-99"}', sig, TEST_SECRET)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(validateSignature(VALID_BODY, "", TEST_SECRET)).toBe(false);
  });

  it("returns false for a truncated signature (wrong length)", () => {
    const sig = sign(VALID_BODY);
    expect(validateSignature(VALID_BODY, sig.slice(0, 10), TEST_SECRET)).toBe(false);
  });

  it("returns false for a too-long signature (wrong length)", () => {
    const sig = sign(VALID_BODY);
    expect(validateSignature(VALID_BODY, sig + "00", TEST_SECRET)).toBe(false);
  });

  it("returns false for non-hex signature", () => {
    expect(validateSignature(VALID_BODY, "not-hex-zzzz", TEST_SECRET)).toBe(false);
  });

  it("returns false for empty body", () => {
    const sig = sign("{}");
    // Body "", sig for "{}" — mismatch on content
    expect(validateSignature("", sig, TEST_SECRET)).toBe(false);
  });

  it("handles empty secret safely", () => {
    const sig = sign(VALID_BODY);
    // With an empty secret the HMAC is computed but won't match a
    // signature made with a real secret — safe to reject.
    expect(validateSignature(VALID_BODY, sig, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full handler (integration)
// ---------------------------------------------------------------------------
describe("handleWebhookWake", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env[TEST_ENV_VAR] = TEST_SECRET;
  });

  afterEach(() => {
    // Restore env to avoid cross-test pollution.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
  });

  // -- config gate ----------------------------------------------------------

  it("returns 503 when webhook wake is disabled (default)", () => {
    const result = handleWebhookWake(VALID_BODY, sign(VALID_BODY));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("disabled");
    }
  });

  it("returns 503 when explicitly disabled", () => {
    const result = handleWebhookWake(VALID_BODY, sign(VALID_BODY), { enabled: false, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(503);
    }
  });

  // -- secret gate ----------------------------------------------------------

  it("returns 500 when the secret env var is not set", () => {
    delete process.env[TEST_ENV_VAR];
    const result = handleWebhookWake(VALID_BODY, sign(VALID_BODY), { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("not configured");
      // Must NOT expose the secret value — only the env-var name.
      expect(result.error).toContain(TEST_ENV_VAR);
      expect(result.error).not.toContain(TEST_SECRET);
    }
  });

  it("returns 500 when the secret env var is set but empty", () => {
    process.env[TEST_ENV_VAR] = "";
    const result = handleWebhookWake(VALID_BODY, sign(VALID_BODY), { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(500);
    }
  });

  // -- signature gate -------------------------------------------------------

  it("returns 401 for a bad signature", () => {
    const badSig = sign(VALID_BODY, "wrong-key");
    const result = handleWebhookWake(VALID_BODY, badSig, { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(401);
      expect(result.error).toContain("invalid signature");
    }
  });

  it("returns 401 for an empty signature header", () => {
    const result = handleWebhookWake(VALID_BODY, "", { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(401);
    }
  });

  // -- payload gate ---------------------------------------------------------

  it("returns 400 for non-JSON body", () => {
    const sig = sign("not-json");
    const result = handleWebhookWake("not-json", sig, { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("JSON");
    }
  });

  it("returns 400 for a JSON body missing objectiveId", () => {
    const body = JSON.stringify({ other: 1 });
    const sig = sign(body);
    const result = handleWebhookWake(body, sig, { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("payload");
    }
  });

  it("returns 400 for a JSON body with empty objectiveId", () => {
    const body = JSON.stringify({ objectiveId: "" });
    const sig = sign(body);
    const result = handleWebhookWake(body, sig, { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(400);
    }
  });

  // -- success --------------------------------------------------------------

  it("returns a job for a valid signed payload", () => {
    const sig = sign(VALID_BODY);
    const result = handleWebhookWake(VALID_BODY, sig, { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("job" in result).toBe(true);
    if ("job" in result) {
      expect(result.job.objectiveId).toBe("obj-42");
      expect(result.job.source).toBe("webhook");
      expect(() => WebhookWakeJobSchema.parse(result.job)).not.toThrow();
      // receivedAt must be a current ISO-8601 datetime.
      expect(new Date(result.job.receivedAt).toISOString()).toBe(result.job.receivedAt);
    }
  });

  it("never exposes the secret value in error messages", () => {
    delete process.env[TEST_ENV_VAR];
    const result = handleWebhookWake(VALID_BODY, sign(VALID_BODY), { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).not.toContain(TEST_SECRET);
    }
  });

  // -- edge cases -----------------------------------------------------------

  it("handles JSON with unicode objectiveId", () => {
    const body = JSON.stringify({ objectiveId: "tâche-42" });
    const sig = sign(body);
    const result = handleWebhookWake(body, sig, { enabled: true, secretEnvVar: TEST_ENV_VAR });
    expect("job" in result).toBe(true);
    if ("job" in result) {
      expect(result.job.objectiveId).toBe("tâche-42");
    }
  });

  it("uses a custom env var name from config", () => {
    const CUSTOM_VAR = "CUSTOM_WEBHOOK_KEY";
    process.env[CUSTOM_VAR] = "custom-secret-xyz";
    const body = JSON.stringify({ objectiveId: "custom-obj" });
    const sig = createHmac("sha256", "custom-secret-xyz").update(body, "utf8").digest("hex");
    const result = handleWebhookWake(body, sig, { enabled: true, secretEnvVar: CUSTOM_VAR });
    expect("job" in result).toBe(true);
    delete process.env[CUSTOM_VAR];
  });
});
