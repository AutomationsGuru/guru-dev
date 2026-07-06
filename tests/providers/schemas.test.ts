import { describe, expect, it } from "vitest";

import { createProviderRouteRegistry, defineProviderRoute, routeFromChatProvider } from "../../src/providers/registry.js";
import { ProviderRouteDescriptorSchema, RouteTypeSchema } from "../../src/providers/schemas.js";

describe("provider route descriptor schemas", () => {
  it("should define the Phase-1 route type contract", () => {
    expect(RouteTypeSchema.options).toEqual([
      "direct-api",
      "operator-provider-plan-auth",
      "native-cli",
      "router-bridge",
      "delegated",
      "deferred",
      "excluded"
    ]);
  });

  it("should validate direct provider/model metadata without secret values", () => {
    const route = ProviderRouteDescriptorSchema.parse({
      providerId: "sakana",
      modelId: "fugu-ultra",
      routeId: "sakana/fugu-ultra",
      displayName: "Fugu Ultra",
      routeType: "direct-api",
      apiFamily: "openai-responses",
      baseUrl: "https://api.sakana.ai/v1",
      capabilities: {
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsTools: true,
        supportsStreaming: true,
        supportsReasoning: true,
        supportsWebSearch: false,
        supportsVision: false,
        supportsJsonMode: true,
        supportsImages: false,
        notes: ["Direct route stays preferred over router aliases."]
      },
      context: {
        contextWindowTokens: 262144,
        maxOutputTokens: 65536
      },
      cost: {
        currency: "USD",
        inputPerMillionTokens: 3,
        outputPerMillionTokens: 15,
        notes: ["Fixture economics, replace with catalog-derived metadata before GREEN."],
        source: "test-fixture"
      },
      credentialSource: {
        type: "env-var",
        envVarName: "SAKANA_API_KEY",
        envVarNames: []
      },
      status: "ready-unverified",
      caveats: ["Smoke not run in this contract test."],
      directFirstRank: 10,
      allowedRouterFallback: true,
      metadata: {
        owner: "Dev 2"
      }
    });

    expect(route.providerId).toBe("sakana");
    expect(route.credentialSource).toMatchObject({ type: "env-var", envVarName: "SAKANA_API_KEY" });
    expect(JSON.stringify(route)).not.toContain("sk-");
  });

  it("should track FR-03 per-route compat flags and default them when omitted", () => {
    const withCompat = ProviderRouteDescriptorSchema.parse({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      routeId: "anthropic/claude-sonnet-4-6",
      routeType: "direct-api",
      apiFamily: "anthropic-messages",
      credentialSource: { type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [] },
      status: "ready-unverified",
      compat: {
        supportsDeveloperRole: false,
        supportsSystemRole: true,
        supportsReasoningEffort: true,
        supportsTemperature: true
      },
      directFirstRank: 10,
      allowedRouterFallback: true
    });

    expect(withCompat.compat).toMatchObject({
      supportsSystemRole: true,
      supportsReasoningEffort: true
    });

    const withoutCompat = ProviderRouteDescriptorSchema.parse({
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
      routeId: "anthropic/claude-haiku-4-5",
      routeType: "direct-api",
      credentialSource: { type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [] },
      status: "ready-unverified",
      directFirstRank: 20,
      allowedRouterFallback: true
    });

    expect(withoutCompat.compat).toEqual({});
  });

  it("should reject operator provider-plan routes that are router fallback candidates", () => {
    const result = ProviderRouteDescriptorSchema.safeParse({
      providerId: "codex",
      modelId: "gpt-5.5-codex-plan",
      routeId: "codex/gpt-5.5-codex-plan",
      routeType: "operator-provider-plan-auth",
      credentialSource: { type: "native-cli-token", envVarNames: [] },
      status: "needs-login",
      directFirstRank: 1,
      allowedRouterFallback: true
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("allowedRouterFallback");
  });

  it("should require exclusion reasons for excluded routes", () => {
    const result = ProviderRouteDescriptorSchema.safeParse({
      providerId: "openrouter",
      modelId: "excluded",
      routeId: "openrouter/excluded",
      routeType: "excluded",
      credentialSource: { type: "none", envVarNames: [] },
      status: "excluded-by-policy",
      directFirstRank: 999,
      allowedRouterFallback: false
    });

    expect(result.success).toBe(false);
  });
});

describe("provider route registry", () => {
  it("should register and query provider routes deterministically", () => {
    const registry = createProviderRouteRegistry();
    const route = defineProviderRoute({
      providerId: "openai",
      modelId: "gpt-5.5",
      routeId: "openai/gpt-5.5",
      routeType: "direct-api",
      apiFamily: "openai-responses",
      credentialSource: { type: "env-var", envVarName: "OPENAI_API_KEY", envVarNames: [] },
      status: "missing-credential",
      directFirstRank: 20,
      allowedRouterFallback: true
    });

    registry.add(route);

    expect(registry.requireByRouteId("openai/gpt-5.5")).toEqual(route);
    expect(registry.byProvider("openai")).toHaveLength(1);
    expect(registry.byModel("openai", "gpt-5.5")).toHaveLength(1);
    expect(registry.toSnapshot().routes).toHaveLength(1);
  });

  it("should reject duplicate route ids", () => {
    const registry = createProviderRouteRegistry();
    const route = defineProviderRoute({
      providerId: "openai",
      modelId: "gpt-5.5",
      routeId: "openai/gpt-5.5",
      routeType: "direct-api",
      credentialSource: { type: "env-var", envVarName: "OPENAI_API_KEY", envVarNames: [] },
      status: "missing-credential",
      directFirstRank: 20,
      allowedRouterFallback: true
    });

    registry.add(route);

    expect(() => registry.add(route)).toThrow("Duplicate provider route id");
  });

  it("should convert current chat provider shapes into route descriptors without importing chat files", () => {
    const route = routeFromChatProvider(
      {
        id: "openai",
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY"
      },
      "gpt-5.5"
    );

    expect(route).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.5",
      routeType: "direct-api",
      allowedRouterFallback: true
    });
  });
});
