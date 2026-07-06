import { describe, expect, it } from "vitest";

import { describeLoginFlow, formatExpiry } from "../../src/model/loginFlow.js";
import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from "../../src/providers/schemas.js";

function makeRoute(overrides: Partial<Parameters<typeof ProviderRouteDescriptorSchema.parse>[0]>): ProviderRouteDescriptor {
  return ProviderRouteDescriptorSchema.parse({
    providerId: "test",
    modelId: "m",
    routeId: "test/m",
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://example.invalid/v1",
    credentialSource: { type: "env-var", envVarName: "TEST_KEY", envVarNames: [] },
    status: "ready-unverified",
    directFirstRank: 1,
    allowedRouterFallback: false,
    ...overrides
  });
}

describe("describeLoginFlow", () => {
  it("api-key lane: env + secret-manager guidance, presence-only, no values", () => {
    const flow = describeLoginFlow(makeRoute({}), {});
    expect(flow.kind).toBe("api-key");
    expect(flow.present).toBe(false);
    const joined = flow.steps.join(" ");
    expect(joined).toContain("TEST_KEY");
    expect(joined).toContain("op item create");
    expect(joined).not.toMatch(/=\s*sk-/); // never a value
  });

  it("already-connected when the credential resolves", () => {
    const flow = describeLoginFlow(makeRoute({}), { TEST_KEY: "present-value" });
    expect(flow.kind).toBe("already-connected");
    expect(flow.present).toBe(true);
    expect(flow.source).toBe("env");
  });

  it("ecosystem-oauth lane points at the provider's own login, not a guru file", () => {
    const route = makeRoute({
      providerId: "grok-cli",
      credentialSource: {
        type: "oauth-cache",
        envVarNames: [],
        // Nonexistent path so the resolver can't connect — we want the login flow,
        // not an already-connected verdict from this machine's real ~/.grok cache.
        filePath: "~/.nonexistent-grok-test/auth.json",
        cacheTokenPath: "*.access_token",
        oauthPolicy: "ecosystem-ok"
      }
    });
    const flow = describeLoginFlow(route, {});
    expect(flow.kind).toBe("ecosystem-oauth");
    expect(flow.steps.join(" ")).toContain("grok auth");
    expect(flow.steps.join(" ")).toContain("~/.nonexistent-grok-test/auth.json");
  });

  it("none-needed for credential-free lanes", () => {
    const flow = describeLoginFlow(makeRoute({ credentialSource: { type: "none", envVarNames: [] } }), {});
    expect(flow.kind).toBe("none-needed");
  });
});

describe("formatExpiry", () => {
  const now = Date.parse("2026-07-04T12:00:00Z");
  it("handles epoch seconds, epoch ms, ISO, absent, and past", () => {
    expect(formatExpiry(undefined, now)).toBe("no expiry");
    expect(formatExpiry(String((now + 30 * 60000) / 1000), now)).toBe("expires in 30m");
    expect(formatExpiry(String(now + 3 * 3600000), now)).toBe("expires in 3h");
    expect(formatExpiry("2026-07-04T11:30:00Z", now)).toBe("expired 30m ago");
    expect(formatExpiry("not-a-date", now)).toBe("expiry: unknown");
  });
});
