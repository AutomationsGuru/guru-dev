import { describe, expect, it } from "vitest";

import {
  createTelemetryEmitter,
  DEFAULT_TELEMETRY_CONFIG,
  isTelemetryEnabled,
  TelemetryConfigSchema,
  type TelemetryEvent
} from '../../src/telemetry/telemetryPolicy.js';

describe("TelemetryConfigSchema — default-off contract (IDEA-F12)", () => {
  it("parses an empty object to enabled:false with a null endpoint", () => {
    const config = TelemetryConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBeNull();
  });

  it("produces a default-off module default (DEFAULT_TELEMETRY_CONFIG)", () => {
    expect(DEFAULT_TELEMETRY_CONFIG.enabled).toBe(false);
    expect(DEFAULT_TELEMETRY_CONFIG.endpoint).toBeNull();
  });

  it("accepts explicit opt-in (enabled:true)", () => {
    const config = TelemetryConfigSchema.parse({ enabled: true });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBeNull();
  });

  it("accepts explicit opt-out (enabled:false) — the honest silent form", () => {
    const config = TelemetryConfigSchema.parse({ enabled: false });
    expect(config.enabled).toBe(false);
  });

  it("rejects non-boolean enabled values instead of guessing", () => {
    expect(() => TelemetryConfigSchema.parse({ enabled: "yes" })).toThrow();
    expect(() => TelemetryConfigSchema.parse({ enabled: 1 })).toThrow();
  });

  it("rejects unknown keys (strict) so typos cannot silently widen the policy", () => {
    expect(() => TelemetryConfigSchema.parse({ enabled: true, telemetry: true })).toThrow();
  });

  it("requires a valid URL when an endpoint is supplied", () => {
    expect(() => TelemetryConfigSchema.parse({ enabled: true, endpoint: "not-a-url" })).toThrow();
    const config = TelemetryConfigSchema.parse({ enabled: true, endpoint: "https://telemetry.example.com/ingest" });
    expect(config.endpoint).toBe("https://telemetry.example.com/ingest");
  });

  it("accepts null endpoint explicitly (wire-unset)", () => {
    const config = TelemetryConfigSchema.parse({ enabled: true, endpoint: null });
    expect(config.endpoint).toBeNull();
  });
});

describe("isTelemetryEnabled — the gate every emit path must consult", () => {
  it("returns false for the module default (absent config)", () => {
    expect(isTelemetryEnabled(DEFAULT_TELEMETRY_CONFIG)).toBe(false);
  });

  it("returns false when config is parsed from an empty object (fresh project)", () => {
    expect(isTelemetryEnabled(TelemetryConfigSchema.parse({}))).toBe(false);
  });

  it("returns false on explicit opt-out", () => {
    expect(isTelemetryEnabled(TelemetryConfigSchema.parse({ enabled: false }))).toBe(false);
  });

  it("returns true only on explicit opt-in", () => {
    expect(isTelemetryEnabled(TelemetryConfigSchema.parse({ enabled: true }))).toBe(true);
  });
});

describe("createTelemetryEmitter — default config means no network emit", () => {
  it("emits nothing under the default (absent) config", async () => {
    const sent: Array<{ event: TelemetryEvent; url: string | null }> = [];
    const emit = createTelemetryEmitter(DEFAULT_TELEMETRY_CONFIG, {
      send: async (event, url) => {
        sent.push({ event, url });
      }
    });
    await emit("session_started", { sessionId: "s-1" });
    await emit("turn_completed", { turns: 3 });
    expect(sent).toEqual([]);
  });

  it("emits nothing on explicit opt-out", async () => {
    const sent: unknown[] = [];
    const emit = createTelemetryEmitter(TelemetryConfigSchema.parse({ enabled: false }), {
      send: async (event) => {
        sent.push(event);
      }
    });
    await emit("session_started", {});
    expect(sent).toEqual([]);
  });

  it("emits under explicit opt-in, delivering name + sanitized payload to the injected transport", async () => {
    const sent: Array<{ event: TelemetryEvent; url: string | null }> = [];
    const config = TelemetryConfigSchema.parse({ enabled: true, endpoint: "https://telemetry.example.com/ingest" });
    const emit = createTelemetryEmitter(config, {
      send: async (event, url) => {
        sent.push({ event, url });
      }
    });
    await emit("session_started", { os: "linux" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://telemetry.example.com/ingest");
    expect(sent[0]?.event).toMatchObject({ name: "session_started", payload: { os: "linux" } });
    expect(typeof sent[0]?.event.timestamp).toBe("string");
  });

  it("works under opt-in even without the optional transport (policy must not crash)", async () => {
    const emit = createTelemetryEmitter(TelemetryConfigSchema.parse({ enabled: true }));
    await expect(emit("ping", {})).resolves.toBeUndefined();
  });

  it("drops the event (not the session) when the transport fails", async () => {
    const emit = createTelemetryEmitter(TelemetryConfigSchema.parse({ enabled: true }), {
      send: async () => {
        throw new Error("network down");
      }
    });
    await expect(emit("ping", {})).resolves.toBeUndefined();
  });
});

describe("createTelemetryEmitter — no secrets in payloads, even when enabled", () => {
  it("redacts secret-shaped keys at any nesting depth before the transport sees them", async () => {
    const sent: TelemetryEvent[] = [];
    const emit = createTelemetryEmitter(TelemetryConfigSchema.parse({ enabled: true }), {
      send: async (event) => {
        sent.push(event);
      }
    });
    await emit("config_snapshot", {
      apiKey: "sk-live-value",
      nested: { accessToken: "tok", list: [{ passphrase: "hunter2" }] },
      safe: "visible"
    });
    expect(sent).toHaveLength(1);
    const payload = sent[0]?.payload as Record<string, unknown>;
    expect(payload.apiKey).toBe("[redacted]");
    expect(payload.safe).toBe("visible");
    expect(JSON.stringify(sent[0])).not.toContain("sk-live-value");
    expect(JSON.stringify(sent[0])).not.toContain("hunter2");
    expect(JSON.stringify(sent[0])).not.toContain("tok");
  });

  it("redacts secret-shaped values (sk-/ghp_/JWT/Bearer/AWS) even under innocent key names", async () => {
    const sent: TelemetryEvent[] = [];
    const emit = createTelemetryEmitter(TelemetryConfigSchema.parse({ enabled: true }), {
      send: async (event) => {
        sent.push(event);
      }
    });
    await emit("note", {
      model: "sk-ant-api03-abcdef123456",
      comment: "ghp_abcdefghij0123456789",
      text: "ordinary words stay"
    });
    const payload = sent[0]?.payload as Record<string, unknown>;
    expect(payload.model).toBe("[redacted]");
    expect(payload.comment).toBe("[redacted]");
    expect(payload.text).toBe("ordinary words stay");
  });

  it("never lets a redacted value reach the transport (structural, not prompt-level)", async () => {
    const sent: string[] = [];
    const emit = createTelemetryEmitter(TelemetryConfigSchema.parse({ enabled: true }), {
      send: async (event) => {
        sent.push(JSON.stringify(event));
      }
    });
    await emit("leak_attempt", {
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      key_material: "AKIAIOSFODNN7EXAMPLE",
      ok: true
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(sent[0]).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sent[0]).toContain("[redacted]");
  });
});
