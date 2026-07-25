import { afterEach, describe, expect, it } from "vitest";

import {
  applyHandoff,
  computeContextPressure,
  DEFAULT_HANDOFF_PRESSURE_THRESHOLD,
  HANDOFF_INJECT_PREFIX,
  HandoffPacketConfigSchema,
  HandoffPacketSchema,
  maybeGenerateHandoff,
  shouldGenerateHandoff
} from '../../src/session/handoffPacket.js';
import type { CompactionState } from '../../src/compaction/schemas.js';
import { clearRegisteredSecretValues, registerSecretValue } from '../../src/safety/secretSafety.js';

afterEach(() => {
  clearRegisteredSecretValues();
});

const FIXED_DATE = new Date("2026-07-19T10:05:00Z");
const now = () => FIXED_DATE;

const config = HandoffPacketConfigSchema.parse({});

function ctx(over: Partial<Parameters<typeof maybeGenerateHandoff>[0]> = {}) {
  return {
    config,
    contextWindowTokens: 128_000,
    lastInputTokens: 0,
    now,
    ...over
  };
}

const compaction: CompactionState = {
  summary: "Folded history: wired handoff packet, added tests.",
  firstKeptEntryId: "e5",
  tokensBefore: 100_000,
  compactedAt: "2026-07-19T09:00:00Z",
  count: 1,
  details: { readFiles: [], modifiedFiles: [] }
};

describe("HandoffPacket config schema", () => {
  it("applies documented defaults", () => {
    const parsed = HandoffPacketConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.contextPressureThreshold).toBe(DEFAULT_HANDOFF_PRESSURE_THRESHOLD);
    expect(parsed.maxPacketChars).toBeGreaterThan(0);
  });

  it("rejects an out-of-range threshold", () => {
    expect(() => HandoffPacketConfigSchema.parse({ contextPressureThreshold: 1.5 })).toThrow();
  });
});

describe("computeContextPressure", () => {
  it("returns the last-input / window fraction clamped to 1", () => {
    expect(computeContextPressure({ contextWindowTokens: 100_000, lastInputTokens: 80_000 })).toBeCloseTo(0.8, 5);
    expect(computeContextPressure({ contextWindowTokens: 100_000, lastInputTokens: 200_000 })).toBe(1);
  });

  it("is 0 when the window is unknown or non-positive", () => {
    expect(computeContextPressure({ contextWindowTokens: undefined, lastInputTokens: 80_000 })).toBe(0);
    expect(computeContextPressure({ contextWindowTokens: 0, lastInputTokens: 80_000 })).toBe(0);
  });
});

describe("shouldGenerateHandoff", () => {
  it("triggers at and above the threshold", () => {
    const atThreshold = Math.ceil(128_000 * DEFAULT_HANDOFF_PRESSURE_THRESHOLD);
    expect(shouldGenerateHandoff({ config, contextWindowTokens: 128_000, lastInputTokens: atThreshold })).toBe(true);
    expect(shouldGenerateHandoff({ config, contextWindowTokens: 128_000, lastInputTokens: atThreshold + 1_000 })).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    const below = Math.floor(128_000 * DEFAULT_HANDOFF_PRESSURE_THRESHOLD) - 1_000;
    expect(shouldGenerateHandoff({ config, contextWindowTokens: 128_000, lastInputTokens: below })).toBe(false);
  });

  it("does not trigger when disabled", () => {
    const off = HandoffPacketConfigSchema.parse({ enabled: false });
    expect(shouldGenerateHandoff({ config: off, contextWindowTokens: 128_000, lastInputTokens: 200_000 })).toBe(false);
  });

  it("does not trigger when the context window is unknown", () => {
    expect(shouldGenerateHandoff({ config, contextWindowTokens: undefined, lastInputTokens: 999_999 })).toBe(false);
  });
});

describe("maybeGenerateHandoff", () => {
  it("returns null below threshold", () => {
    expect(maybeGenerateHandoff(ctx({ lastInputTokens: 10_000 }))).toBeNull();
  });

  it("returns a validated packet at/above threshold with compaction residual composed in", () => {
    const atThreshold = Math.ceil(128_000 * DEFAULT_HANDOFF_PRESSURE_THRESHOLD);
    const packet = maybeGenerateHandoff(ctx({ lastInputTokens: atThreshold, compaction }));
    expect(packet).not.toBeNull();
    const parsed = HandoffPacketSchema.parse(packet);
    expect(parsed.generatedAt).toBe(FIXED_DATE.toISOString());
    expect(parsed.contextPressure).toBeCloseTo(DEFAULT_HANDOFF_PRESSURE_THRESHOLD, 5);
    expect(parsed.summary).toContain("Compaction residual");
    expect(parsed.summary).toContain(compaction.summary);
  });

  it("includes the operator focus note when supplied", () => {
    const packet = maybeGenerateHandoff(
      ctx({ lastInputTokens: 200_000, focusNote: "Finish the apply-inject path." })
    );
    expect(packet?.summary).toContain("Operator focus");
    expect(packet?.summary).toContain("Finish the apply-inject path.");
  });

  it("still generates an honest status body when no residual or focus is supplied", () => {
    const packet = maybeGenerateHandoff(ctx({ lastInputTokens: 200_000 }));
    expect(packet).not.toBeNull();
    expect(packet?.summary).toContain("Status");
    expect(packet?.summary).toContain("handoff threshold");
  });

  it("scrubs a registered secret value out of the rendered body", () => {
    const secret = "sk-live-secret-1234567890";
    registerSecretValue(secret);
    const packet = maybeGenerateHandoff(
      ctx({
        lastInputTokens: 200_000,
        compaction: { ...compaction, summary: `Token is ${secret} right now.` }
      })
    );
    expect(packet?.summary).not.toContain(secret);
    expect(packet?.summary).toContain("[redacted:credential]");
  });

  it("caps the rendered body at maxPacketChars", () => {
    const capped = HandoffPacketConfigSchema.parse({ maxPacketChars: 200 });
    const big = "x".repeat(50_000);
    const packet = maybeGenerateHandoff(
      ctx({ config: capped, lastInputTokens: 200_000, compaction: { ...compaction, summary: big } })
    );
    expect(packet).not.toBeNull();
    expect(packet!.summary.length).toBeLessThanOrEqual(200 + 60);
    expect(packet?.summary).toContain("packet truncated");
  });
});

describe("applyHandoff", () => {
  it("prepends the inject prefix with pressure + timestamp before the summary", () => {
    const packet = maybeGenerateHandoff(ctx({ lastInputTokens: 200_000, compaction }))!;
    const applied = applyHandoff(packet);
    expect(applied.startsWith(HANDOFF_INJECT_PREFIX)).toBe(true);
    // Pressure renders as a percentage and the body follows on the next line.
    expect(applied).toContain("% context pressure");
    expect(applied).toContain(FIXED_DATE.toISOString());
    const bodyLine = applied.split("\n").slice(1).join("\n");
    expect(bodyLine).toContain(compaction.summary);
  });

  it("validates its input — a malformed packet is rejected, not silently applied", () => {
    expect(() => applyHandoff({ generatedAt: "", contextPressure: 0.9, summary: "x" })).toThrow();
    expect(() => applyHandoff({ generatedAt: "t", contextPressure: 2, summary: "x" } as never)).toThrow();
  });

  it("is pure: applying twice yields identical inject text for the same packet", () => {
    const packet = maybeGenerateHandoff(ctx({ lastInputTokens: 200_000, compaction }))!;
    expect(applyHandoff(packet)).toBe(applyHandoff(packet));
  });
});
