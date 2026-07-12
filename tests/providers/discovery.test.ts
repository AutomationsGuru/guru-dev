import { describe, expect, it } from "vitest";

import { createDirectProviderCatalog } from "../../src/providers/catalog.js";
import { scanProviderReadiness } from "../../src/providers/discovery.js";

describe("provider/model readiness discovery", () => {
  it("should check env var names only and never return values", () => {
    const catalog = createDirectProviderCatalog();
    const rows = scanProviderReadiness(catalog, {
      env: { has: (name) => name === "SAKANA_API_KEY" },
      userEnv: { has: () => false },
      routerHealth: { endpoint: "http://127.0.0.1:4000/health/liveliness", status: "online" }
    });

    const sakana = rows.find((row) => row.routeId === "sakana/fugu-ultra");
    const gemini = rows.find((row) => row.routeId === "gemini/gemini-3.5-flash");

    expect(sakana).toMatchObject({ status: "ready-unverified", presentEnvVarNames: ["SAKANA_API_KEY"], missingEnvVarNames: [] });
    expect(gemini).toMatchObject({ status: "missing-key", missingEnvVarNames: ["GEMINI_API_KEY"] });
    expect(JSON.stringify(rows)).not.toContain("present-value");
  });

  it("counts vault-held env names as PRESENT — a vault key lights up its provider like env", () => {
    const catalog = createDirectProviderCatalog();
    const rows = scanProviderReadiness(catalog, { env: { has: () => false }, vaultNames: new Set(["ANTHROPIC_API_KEY"]) });
    const anthropic = rows.find((row) => row.routeId === "anthropic/claude-opus-4-8");
    expect(anthropic?.presentEnvVarNames).toContain("ANTHROPIC_API_KEY");
    expect(anthropic?.missingEnvVarNames).not.toContain("ANTHROPIC_API_KEY");
    expect(anthropic?.status).not.toBe("missing-key"); // lit up by the vault
  });

  it("should mark operator login and delegated/native CLI routes distinctly", () => {
    const rows = scanProviderReadiness(createDirectProviderCatalog(), { env: { has: () => false } });

    expect(rows.find((row) => row.routeId === "openai-codex/gpt-5.6-sol")?.status).toBe("needs-login");
    expect(rows.find((row) => row.routeId === "grok/grok-build")?.status).toBe("needs-login");

    // Positive path: a guru-oauth lane with a signed-in token (vault OR CLI cache) reads
    // as ready-unverified, not needs-login.
    const signedIn = scanProviderReadiness(createDirectProviderCatalog(), {
      env: { has: () => false },
      oauthPresent: (providerId) => providerId === "grok"
    });
    expect(signedIn.find((row) => row.routeId === "grok/grok-build")?.status).toBe("ready-unverified");
    expect(signedIn.find((row) => row.routeId === "openai-codex/gpt-5.6-sol")?.status).toBe("needs-login");
  });

  it("should mark router bridge routes offline when health is not online", () => {
    const rows = scanProviderReadiness(
      [
        {
          providerId: "litellm-router",
          modelId: "router-openai-api",
          routeId: "litellm-router/router-openai-api",
          routeType: "router-bridge",
          credentialSource: { type: "router-key", envVarNames: ["OPENAI_API_KEY"] },
          capabilities: { inputModalities: ["text"], outputModalities: ["text"], supportsTools: false, supportsStreaming: true, supportsReasoning: false, supportsWebSearch: false, supportsVision: false, supportsJsonMode: false, supportsImages: false, notes: [] },
          context: {},
          cost: { currency: "USD", notes: [] },
          status: "ready-unverified",
          caveats: [],
          compat: {},
          directFirstRank: 500,
          allowedRouterFallback: true,
          metadata: {}
        }
      ],
      { env: { has: () => true }, routerHealth: { endpoint: "http://127.0.0.1:4000/health/liveliness", status: "offline" } }
    );

    expect(rows[0]?.status).toBe("router-offline");
  });
});
