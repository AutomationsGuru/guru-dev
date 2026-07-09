import { describe, expect, it } from "vitest";

import {
  assessRouteConnectability,
  buildModelDrillMenuItems,
  sortedRoutes
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

