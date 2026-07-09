import { describe, expect, it } from "vitest";

import { buildStatusBar } from "../../src/guru.js";
import { visibleWidth } from "../../src/tui/components.js";
import { ProviderRouteDescriptorSchema } from "../../src/providers/schemas.js";
import { createFileMemoryStore } from "../../src/memory/store.js";
import { createLookAheadEngine } from "../../src/lookahead/engine.js";
import { createMandateStore } from "../../src/mandates/store.js";

const route = ProviderRouteDescriptorSchema.parse({
  providerId: "zai-coding-cn",
  modelId: "glm-5.2",
  routeId: "zai-coding-cn/glm-5.2",
  routeType: "operator-provider-plan-auth",
  apiFamily: "anthropic-messages",
  baseUrl: "https://example.invalid",
  credentialSource: { type: "none", envVarNames: [] },
  context: { contextWindowTokens: 1_000_000 },
  compat: { supportsReasoningEffort: true },
  status: "active",
  directFirstRank: 1,
  allowedRouterFallback: false
});

// Minimal GuruState-shaped fixture (buildStatusBar only reads a handful of fields).
function baseState(overrides: Record<string, unknown> = {}): never {
  const lookahead = createLookAheadEngine({ config: {}, spawnScout: () => ({ taskId: "t" }), enumerateForks: () => [] });
  return {
    session: null,
    connectedRoute: route,
    modelIdOverride: null,
    usage: { inputTokens: 12_400, outputTokens: 3_100, turns: 4, lastInputTokens: 705_000 },
    activeRole: null,
    yolo: false,
    lookahead,
    mandate: { grants: [], denies: [] },
    ...overrides
  } as never;
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/gu, "");

describe("buildStatusBar — full-width indicator bar", () => {
  it("fills wide terminals exactly and right-justifies the model", () => {
    for (const cols of [120, 160, 200]) {
      const bar = strip(buildStatusBar(baseState(), cols));
      expect(visibleWidth(bar), `fills ${cols}`).toBe(cols);
      expect(bar.trimEnd().endsWith("· high")).toBe(true);
    }
  });

  it("overflows (never truncates the model) when the terminal is too narrow", () => {
    const bar = strip(buildStatusBar(baseState(), 40));
    expect(visibleWidth(bar)).toBeGreaterThan(40); // content preserved, wraps naturally
    expect(bar).toContain("zai-coding-cn/glm-5.2");
  });

  it("shows context% and session tokens", () => {
    const bar = strip(buildStatusBar(baseState(), 160));
    expect(bar).toMatch(/71%|70%/); // 705k / 1M
    expect(bar).toContain("tok");
  });

  it("renders mode chips only when active (YOLO / scout / mandate / busy / queue)", () => {
    expect(strip(buildStatusBar(baseState(), 160))).not.toContain("YOLO");
    expect(strip(buildStatusBar(baseState({ yolo: true }), 160))).toContain("YOLO");

    const withMandate = baseState({ mandate: { grants: [{ scope: "machine", verbs: ["read"], grantedAt: "t" }], denies: [] } });
    expect(strip(buildStatusBar(withMandate, 160))).toContain("mandate");

    const scout = createLookAheadEngine({ config: { enabled: true }, spawnScout: () => ({ taskId: "t" }), enumerateForks: () => [] });
    expect(strip(buildStatusBar(baseState({ lookahead: scout }), 160))).toContain("scout");

    expect(strip(buildStatusBar(baseState({ busy: true }), 160))).toContain("…run");
    expect(strip(buildStatusBar(baseState(), 160))).not.toContain("…run");

    const withQueue = baseState({
      agentSession: { queueDepth: () => 2 }
    });
    expect(strip(buildStatusBar(withQueue, 160))).toContain("q:2");
    expect(strip(buildStatusBar(baseState({ agentSession: { queueDepth: () => 0 } }), 160))).not.toMatch(/q:\d/);
  });

  it("shows the active suit label when suited", () => {
    const suited = baseState({ activeRole: { slug: "finance", label: "finances", capabilityMode: "all", tools: [], skills: [], extensions: [], mcpServers: [], modelPreference: { requires: ["chat"] }, verifiedTools: [], wornCount: 1, notes: "" } });
    expect(strip(buildStatusBar(suited, 160))).toContain("finances");
  });

  it("visibleWidth counts DISPLAY cells, not UTF-16 code units (CJK/emoji = 2)", () => {
    // Old code returned .length (code units), so wide chars under-measured by 1
    // cell each and the status bar gap math overflowed the terminal edge.
    expect(visibleWidth("汉")).toBe(2); // 1 code unit, 2 display cells
    expect(visibleWidth("ab")).toBe(2);
    expect(visibleWidth("a汉b")).toBe(4); // 3 code units, 4 display cells
    expect(visibleWidth("😀")).toBe(2); // 2 code units (surrogate pair), 2 display cells
    expect(visibleWidth("汉test😀")).toBe(8); // 6 code units, 8 display cells
    // ANSI escapes still don't count.
    expect(visibleWidth("\x1b[1m汉\x1b[0m")).toBe(2);
  });

  it("status bar still fills exactly with a CJK suit label (gap math is display-width-honest)", () => {
    const suited = baseState({ activeRole: { slug: "finance", label: "财务", capabilityMode: "all", tools: [], skills: [], extensions: [], mcpServers: [], modelPreference: { requires: ["chat"] }, verifiedTools: [], wornCount: 1, notes: "" } });
    for (const cols of [120, 160]) {
      const bar = strip(buildStatusBar(suited, cols));
      expect(visibleWidth(bar), `fills ${cols} with CJK label`).toBe(cols);
    }
  });

  // The store imports must resolve (guru.ts pulls them) — smoke that the module graph is intact.
  it("imports the runtime organs without side effects", () => {
    expect(typeof createFileMemoryStore).toBe("function");
    expect(typeof createMandateStore).toBe("function");
  });
});
