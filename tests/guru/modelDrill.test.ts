import { describe, expect, it } from "vitest";

import {
  assessRouteConnectability,
  buildCompactModelRouteRows,
  buildModelDrillMenuItems,
  noModelConnectedHint,
  resolveCompactRouteSelector,
  sortedRoutes,
  validateModelIdOverride
} from "../../src/guru.js";
import { createDirectProviderCatalog } from "../../src/providers/catalog.js";
import { defineProviderRoute } from "../../src/providers/registry.js";
import { isChatCapableFamily } from "../../src/model/directChat.js";

describe("assessRouteConnectability", () => {
  const routes = createDirectProviderCatalog();

  it("reflects whether a direct API route has a usable credential", () => {
    const route = routes.find((row) => row.routeId === "sakana/fugu-ultra");
    expect(route).toBeDefined();
    const assessment = assessRouteConnectability(route!);
    if (process.env.SAKANA_API_KEY) {
      expect(assessment.connectable).toBe(true);
      expect(assessment.mode).toBe("direct");
    } else {
      expect(assessment.connectable).toBe(false);
      expect(assessment.reason).toMatch(/SAKANA_API_KEY|credential|env/iu);
    }
  });

  it("rejects non-chat-capable families", () => {
    const route = defineProviderRoute({
      providerId: "embed-only",
      modelId: "text-embed",
      routeId: "embed-only/text-embed",
      routeType: "direct-api",
      apiFamily: "google-gemini",
      baseUrl: "https://example.test/v1",
      credentialSource: { type: "env-var", envVarName: "EMBED_KEY", envVarNames: [] },
      status: "ready-unverified",
      directFirstRank: 99,
      allowedRouterFallback: false
    });
    const assessment = assessRouteConnectability(route);
    expect(assessment.connectable).toBe(false);
    expect(assessment.reason).toMatch(/not chat-capable/iu);
  });

  it("blocks operator-auth routes that are not direct-ready (v1.3.0: no CLI delegate)", () => {
    const route = defineProviderRoute({
      providerId: "minimax-oauth",
      modelId: "m2",
      routeId: "minimax-oauth/m2",
      routeType: "operator-provider-plan-auth",
      apiFamily: "openai-responses",
      credentialSource: { type: "oauth-cache", envVarName: "MINIMAX_API_KEY", envVarNames: [], filePath: "~/.mavis/auth.json" },
      status: "needs-login",
      directFirstRank: 50,
      allowedRouterFallback: false
    });
    const assessment = assessRouteConnectability(route);
    expect(assessment.connectable).toBe(false);
    expect(assessment.mode).toBe("none");
  });
});

describe("buildModelDrillMenuItems", () => {
  const routes = createDirectProviderCatalog();

  it("lists chat-capable routes by routeId (not numeric index)", () => {
    const items = buildModelDrillMenuItems(routes, { maxUnavailable: 3 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.id.startsWith("/model "))).toBe(true);
    expect(items[0]?.id).toMatch(/^\/model [a-z0-9-]+\//u);
  });

  it("pins the connected route to the top of connectable rows", () => {
    const connected = sortedRoutes(routes).find((route) => isChatCapableFamily(route.apiFamily));
    expect(connected).toBeDefined();
    const items = buildModelDrillMenuItems(routes, { connectedRouteId: connected!.routeId, maxUnavailable: 0 });
    expect(items[0]?.label).toBe(connected!.routeId);
    expect(items[0]?.hint).toMatch(/connected/iu);
  });

  it("caps the unavailable tail so the drill stays usable", () => {
    const chatCapable = routes.filter((route) => isChatCapableFamily(route.apiFamily));
    const connectableCount = chatCapable.filter((route) => assessRouteConnectability(route).connectable).length;
    const items = buildModelDrillMenuItems(routes, { maxUnavailable: 2 });
    expect(items.length).toBeLessThanOrEqual(connectableCount + 2);
    expect(items.length).toBeLessThan(chatCapable.length);
  });
});

describe("buildCompactModelRouteRows", () => {
  it("bounds the typed /model output while preserving actionable route commands", () => {
    const rows = buildCompactModelRouteRows(createDirectProviderCatalog(), { maxItems: 8 });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.every((row) => row.id.startsWith("/model "))).toBe(true);
  });

  it("resolves a displayed compact index to the route shown on that row", () => {
    const routes = createDirectProviderCatalog();
    const rows = buildCompactModelRouteRows(routes, { maxItems: 10 });
    const selected = resolveCompactRouteSelector(routes, "1", { maxItems: 10 });

    expect(selected?.routeId).toBe(rows[0]?.label);
  });
});

describe("validateModelIdOverride", () => {
  it("accepts a plain model id", () => {
    expect(validateModelIdOverride("gpt-4.1")).toBeNull();
    expect(validateModelIdOverride("  claude-sonnet-4  ")).toBeNull();
  });

  it("rejects empty and whitespace-only overrides", () => {
    expect(validateModelIdOverride("")?.message).toMatch(/empty/iu);
    expect(validateModelIdOverride("   ")?.message).toMatch(/empty/iu);
  });

  it("rejects overrides that contain whitespace (stray args)", () => {
    const bad = validateModelIdOverride("gpt-4.1 oops");
    expect(bad?.message).toMatch(/whitespace/iu);
    expect(bad?.hint).toBe("gpt-4.1");
  });
});

describe("noModelConnectedHint", () => {
  it("suggests a routeId (not a catalog index) when a direct-ready route exists", () => {
    const routes = createDirectProviderCatalog();
    const hint = noModelConnectedHint(routes);
    // Either a real /model <routeId> (never a bare index) or an honest empty-catalog message.
    if (hint.includes("/model ")) {
      expect(hint).toMatch(/\/model [a-z0-9][a-z0-9./_-]+/iu);
      expect(hint).not.toMatch(/\/model \d+\s*$/u);
      // Suggested id must be a real connectable catalog route.
      const id = hint.match(/\/model ([^\s]+)/u)?.[1];
      expect(id).toBeTruthy();
      const route = routes.find((row) => row.routeId === id);
      expect(route).toBeDefined();
      expect(assessRouteConnectability(route!).connectable).toBe(true);
    } else {
      expect(hint).toMatch(/no routes have a usable credential/iu);
    }
  });

  it("never emits a bare numeric /model N for a catalog with no usable credentials", () => {
    const dead = defineProviderRoute({
      providerId: "dead",
      modelId: "none",
      routeId: "dead/none",
      routeType: "direct-api",
      apiFamily: "openai-chat-completions",
      baseUrl: "https://example.test/v1",
      credentialSource: { type: "env-var", envVarName: "GURU_TEST_NO_SUCH_KEY_EVER", envVarNames: [] },
      status: "missing-credential",
      directFirstRank: 1,
      allowedRouterFallback: false
    });
    const hint = noModelConnectedHint([dead]);
    expect(hint).toMatch(/no routes have a usable credential/iu);
    expect(hint).not.toMatch(/\/model \d+/u);
  });
});
