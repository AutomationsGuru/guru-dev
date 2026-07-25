import { describe, expect, it } from "vitest";

import {
  LangSmithTraceConfigSchema,
  createLangSmithTraceExporter,
  langSmithTraceGapRecord
} from '../../src/attach/langsmithTraceAttachStub.js';

function makeExporter(configOverrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const config = LangSmithTraceConfigSchema.parse({ ...configOverrides });
  return createLangSmithTraceExporter({ config, env });
}

const baseSpan = { name: "session.turn", input: "user asked a question", output: "assistant answered" };

describe("LangSmithTraceConfigSchema", () => {
  it("is disabled by default — no default-on telemetry", () => {
    const config = LangSmithTraceConfigSchema.parse({});

    expect(config.enabled).toBe(false);
    expect(config.userApproved).toBe(false);
    expect(config.apiKeyEnvVar).toBe("LANGSMITH_API_KEY");
  });
});

describe("langSmithTraceGapRecord", () => {
  it("returns a non-empty ATTACH parity gap with a promotion trigger", () => {
    const gap = langSmithTraceGapRecord("2026-07-19T07:13:00.000Z");

    expect(gap.move).toBe("attach");
    expect(gap.capability.length).toBeGreaterThan(0);
    expect(gap.note.length).toBeGreaterThan(0);
    expect(gap.trigger.length).toBeGreaterThan(0);
    expect(gap.id).toMatch(/^gap-/u);
  });
});

describe("createLangSmithTraceExporter.status", () => {
  it("reports disabled by default instead of impersonating a live trace sink", async () => {
    const status = await makeExporter().status();

    expect(status.status).toBe("disabled");
    expect(status.exportEnabled).toBe(false);
  });

  it("reports missing-env (env NAME only) when enabled without a key", async () => {
    const status = await makeExporter({ enabled: true, userApproved: true, apiKeyEnvVar: "TEAM_LANGSMITH_KEY" }, {}).status();

    expect(status.status).toBe("missing-env");
    expect(status.missingEnvNames).toEqual(["TEAM_LANGSMITH_KEY"]);
    expect(status.exportEnabled).toBe(false);
  });

  it("reports awaiting-approval when enabled with a key but no operator approval", async () => {
    const status = await makeExporter({ enabled: true, userApproved: false }, { LANGSMITH_API_KEY: "present" }).status();

    expect(status.status).toBe("awaiting-approval");
    expect(status.exportEnabled).toBe(false);
  });

  it("reports ready only when enabled + approved + key present", async () => {
    const status = await makeExporter({ enabled: true, userApproved: true }, { LANGSMITH_API_KEY: "present" }).status();

    expect(status.status).toBe("ready");
    expect(status.exportEnabled).toBe(true);
    expect(status.missingEnvNames).toEqual([]);
  });
});

describe("createLangSmithTraceExporter.exportSpan", () => {
  it("blocks export when disabled (no telemetry leaves by default)", async () => {
    const result = await makeExporter({}, { LANGSMITH_API_KEY: "present" }).exportSpan(baseSpan);

    expect(result.status).toBe("blocked");
  });

  it("blocks export without operator approval even when enabled with a key", async () => {
    const result = await makeExporter({ enabled: true, userApproved: false }, { LANGSMITH_API_KEY: "present" }).exportSpan(baseSpan);

    expect(result.status).toBe("blocked");
  });

  it("blocks export when the key env var is missing", async () => {
    const result = await makeExporter({ enabled: true, userApproved: true }, {}).exportSpan(baseSpan);

    expect(result.status).toBe("blocked");
  });

  it("blocks export when the span contains a potential secret (structural pre-export scrub)", async () => {
    const secretSpan = { name: "session.turn", input: "use api_key: ghp_abcdefghijklmnopqrstuvwxyz123456", output: "done" };
    const result = await makeExporter({ enabled: true, userApproved: true }, { LANGSMITH_API_KEY: "present" }).exportSpan(secretSpan);

    expect(result.status).toBe("blocked");
    expect(result.summary).not.toContain("ghp_");
  });

  it("is a stub: even when fully approved it does not silently pretend to deliver to LangSmith", async () => {
    const result = await makeExporter({ enabled: true, userApproved: true }, { LANGSMITH_API_KEY: "present" }).exportSpan(baseSpan);

    // The stub is ATTACH-only scaffolding: it must not claim a real export happened.
    expect(result.status).not.toBe("exported");
  });
});
