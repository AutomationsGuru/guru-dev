import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDirectProviderCatalog } from "../../src/providers/catalog.js";
import { planRoute } from "../../src/providers/routePlanner.js";
import { parseLiteLlmConfigYaml } from "../../src/router/configParser.js";

const fixturePath = join(process.cwd(), "tests", "fixtures", "litellm.config.yaml");

describe("direct provider catalog", () => {
  it("should represent all required Phase-1 direct provider lanes without OpenRouter", () => {
    const catalog = createDirectProviderCatalog();
    const providers = new Set(catalog.map((route) => route.providerId));

    for (const provider of ["anthropic", "openai-codex", "minimax", "grok-cli", "gemini", "ollama-local", "zai", "zai-coding-cn", "sakana", "azure-foundry", "azure-openai-responses", "bigmodel", "deepseek", "openai", "perplexity-agent", "perplexity-sonar", "xai"]) {
      expect(providers.has(provider), provider).toBe(true);
    }
    expect(providers.has("openrouter")).toBe(false);
    expect(catalog.some((route) => route.routeType === "operator-provider-plan-auth" && route.allowedRouterFallback)).toBe(false);
  });
});

describe("direct-first route planner", () => {
  it("should select a direct route before a router alias when direct is usable", () => {
    const manifest = parseLiteLlmConfigYaml(readFileSync(fixturePath, "utf8"));
    const decision = planRoute({ providerId: "sakana", modelId: "fugu-ultra", allowRouterBridge: true }, createDirectProviderCatalog(), manifest.aliases);

    expect(decision).toMatchObject({ verdict: "selected", choiceKind: "direct" });
    expect(decision.choice?.routeId).toBe("sakana/fugu-ultra");
  });

  it("should reject routing operator-owned plan auth through LiteLLM", () => {
    const decision = planRoute({ providerId: "openai-codex", modelId: "gpt-5.5", requireRouterBridge: true }, createDirectProviderCatalog(), []);

    expect(decision.verdict).toBe("rejected");
    expect(decision.policyReason).toMatch(/cannot be routed through LiteLLM/i);
  });

  it("should allow explicit router bridge aliases and carry Vertex Claude quota caveats", () => {
    const manifest = parseLiteLlmConfigYaml(readFileSync(fixturePath, "utf8"));
    const decision = planRoute({ modelId: "router-vertex-claude-sonnet-4-6", requireRouterBridge: true }, createDirectProviderCatalog(), manifest.aliases);

    expect(decision).toMatchObject({ verdict: "selected", choiceKind: "router-bridge" });
    expect(decision.routerAlias?.alias).toBe("router-vertex-claude-sonnet-4-6");
    expect(decision.caveats.join("\n")).toMatch(/pending quota/i);
  });

  it("should reject OpenRouter by policy even when requested explicitly", () => {
    const decision = planRoute({ providerId: "openrouter", allowRouterBridge: true }, createDirectProviderCatalog(), []);

    expect(decision.verdict).toBe("rejected");
    expect(decision.policyReason).toMatch(/OpenRouter is excluded/i);
  });
});
