import { describe, expect, it } from "vitest";

import { createDirectProviderCatalog } from "../../src/providers/catalog.js";

/**
 * Mini-catwalk columns (Foundation Wave PR 1, 2026-07-04): canonical env names,
 * pinned family+endpoint corrections for the two misconfigured lanes (data
 * edits only — lanes NOT flipped), and the oauthPolicy fence.
 */
describe("catalog mini-catwalk columns", () => {
  const catalog = createDirectProviderCatalog();

  it("zai-coding-cn is corrected to anthropic-messages @ api.z.ai (lane not flipped)", () => {
    const routes = catalog.filter((route) => route.providerId === "zai-coding-cn");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.apiFamily).toBe("anthropic-messages");
      expect(route.baseUrl).toBe("https://api.z.ai/api/anthropic");
      expect(route.routeType).toBe("operator-provider-plan-auth");
      expect(route.status).toBe("active"); // flipped 2026-07-04 on live probe pass (glm-5.2/5-turbo/4.7)
      expect(route.credentialSource.envVarName).toBe("ZAI_CODING_CN_API_KEY");
      expect(route.credentialSource.envVarNames).toContain("ZAI_API_KEY");
      expect(route.credentialSource.filePath).toBe("~/.zcode/v2/config.json");
      expect(route.credentialSource.cacheTokenPath).toBe("provider.builtin:zai-coding-plan.options.apiKey");
      expect(route.credentialSource.oauthPolicy).toBe("ecosystem-ok");
    }
  });

  it("grok-cli is corrected to openai-responses @ cli-chat-proxy.grok.com (lane not flipped)", () => {
    const routes = catalog.filter((route) => route.providerId === "grok-cli");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.apiFamily).toBe("openai-responses");
      expect(route.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
      expect(route.routeType).toBe("native-cli"); // NOT flipped
      expect(route.status).toBe("delegated"); // NOT flipped
      expect(route.credentialSource.filePath).toBe("~/.grok/auth.json");
      expect(route.credentialSource.cacheTokenPath).toBe("*.access_token");
      expect(route.credentialSource.oauthPolicy).toBe("ecosystem-ok");
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

  it("bigmodel/zai lanes carry the crush-canonical ZHIPU_API_KEY fallback", () => {
    for (const providerId of ["bigmodel", "zai"]) {
      const route = catalog.find((candidate) => candidate.providerId === providerId);
      expect(route, providerId).toBeDefined();
      expect(route?.credentialSource.envVarNames).toContain("ZHIPU_API_KEY");
    }
  });

  it("no credentialSource anywhere carries a token-shaped value (presence-over-value)", () => {
    for (const route of catalog) {
      const flat = JSON.stringify(route.credentialSource);
      expect(flat).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      expect(flat).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    }
  });
});
