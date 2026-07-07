import { describe, expect, it } from "vitest";

import { createDirectProviderCatalog } from "../../src/providers/catalog.js";

/**
 * Mini-catwalk columns (Foundation Wave PR 1, 2026-07-04): canonical env names,
 * pinned family+endpoint corrections for the two misconfigured lanes (data
 * edits only — lanes NOT flipped), and the oauthPolicy fence.
 */
describe("catalog mini-catwalk columns", () => {
  const catalog = createDirectProviderCatalog();

  it("zai-coding is a plain-plan-key Bearer anthropic-messages coding lane @ api.z.ai (no cache)", () => {
    const routes = catalog.filter((route) => route.providerId === "zai-coding");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.apiFamily).toBe("anthropic-messages");
      expect(route.baseUrl).toBe("https://api.z.ai/api/anthropic");
      expect(route.routeType).toBe("operator-provider-plan-auth");
      expect(route.status).toBe("active"); // GLM Coding Plan, live-probed glm-5.2/5-turbo/4.7
      expect(route.wire?.authHeaderStyle).toBe("bearer"); // Bearer, NOT x-api-key
      expect(route.credentialSource.envVarName).toBe("ZAI_CODING_CN_API_KEY");
      expect(route.credentialSource.envVarNames).toContain("Z_AI_API_KEY"); // same coding key, alt spelling
      expect(route.credentialSource.filePath).toBeUndefined(); // 2026-07: dropped the stale ~/.zcode oauth-cache — it's a plain plan key
    }
  });

  it("grok is the SuperGrok plan lane: guru-oauth @ cli-chat-proxy.grok.com + x-grok-client-version", () => {
    const routes = catalog.filter((route) => route.providerId === "grok");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.apiFamily).toBe("openai-responses");
      expect(route.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
      expect(route.routeType).toBe("operator-provider-plan-auth"); // native OAuth plan lane, not a CLI
      expect(route.status).toBe("needs-login"); // guru-native OAuth or ~/.grok shortcut; flips on a live turn
      expect(route.credentialSource.type).toBe("guru-oauth"); // vaulted token — no ~/.grok filePath in the lane
      expect(route.credentialSource.filePath).toBeUndefined();
      expect(route.wire?.headers?.some((header) => header.header === "x-grok-client-version")).toBe(true);
      expect(route.compat.supportsReasoningEffort).toBe(false);
    }
  });

  it("anthropic is hard-fenced: oauthPolicy=forbidden, API key only", () => {
    const routes = catalog.filter((route) => route.providerId === "anthropic");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.credentialSource.oauthPolicy).toBe("forbidden");
      expect(route.credentialSource.envVarName).toBe("ANTHROPIC_API_KEY");
      expect(route.credentialSource.filePath).toBeUndefined(); // no cache pointer, ever
    }
  });

  it("canonical crush env names are present on the flagship direct lanes", () => {
    const byProvider = new Map<string, string | undefined>();
    for (const route of catalog) {
      if (!byProvider.has(route.providerId)) {
        byProvider.set(route.providerId, route.credentialSource.envVarName);
      }
    }
    expect(byProvider.get("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(byProvider.get("openai")).toBe("OPENAI_API_KEY");
    expect(byProvider.get("xai")).toBe("XAI_API_KEY");
    expect(byProvider.get("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(byProvider.get("gemini")).toBe("GEMINI_API_KEY");
    expect(byProvider.get("minimax")).toBe("MINIMAX_API_KEY");
  });

  it("bigmodel (Zhipu mainland) keeps the ZHIPU_API_KEY fallback; zai-api is the distinct Z.ai international platform", () => {
    const bigmodel = catalog.find((route) => route.providerId === "bigmodel");
    expect(bigmodel?.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(bigmodel?.credentialSource.envVarNames).toContain("ZHIPU_API_KEY");
    const zaiApi = catalog.find((route) => route.providerId === "zai-api");
    expect(zaiApi?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(zaiApi?.credentialSource.envVarName).toBe("ZAI_API_KEY");
  });

  it("no credentialSource anywhere carries a token-shaped value (presence-over-value)", () => {
    for (const route of catalog) {
      const flat = JSON.stringify(route.credentialSource);
      expect(flat).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      expect(flat).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    }
  });
});
