import { describe, expect, it } from "vitest";

import { resolveProviderWire, defaultHeaderStyle } from "../../src/model/providerWire.js";
import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from "../../src/providers/schemas.js";

function makeRoute(overrides: Partial<Parameters<typeof ProviderRouteDescriptorSchema.parse>[0]>): ProviderRouteDescriptor {
  return ProviderRouteDescriptorSchema.parse({
    providerId: "test",
    modelId: "m",
    routeId: "test/m",
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "https://example.invalid/v1",
    credentialSource: { type: "env-var", envVarName: "K", envVarNames: [] },
    status: "ready-unverified",
    directFirstRank: 1,
    allowedRouterFallback: false,
    ...overrides
  });
}

describe("defaultHeaderStyle", () => {
  it("azure = api-key, anthropic/bedrock = x-api-key, else bearer", () => {
    expect(defaultHeaderStyle(makeRoute({ providerId: "azure-foundry" }))).toBe("api-key");
    expect(defaultHeaderStyle(makeRoute({ providerId: "anthropic", apiFamily: "anthropic-messages" }))).toBe("x-api-key");
    expect(defaultHeaderStyle(makeRoute({ providerId: "aws-bedrock" }))).toBe("x-api-key");
    expect(defaultHeaderStyle(makeRoute({ providerId: "openai", apiFamily: "openai-responses" }))).toBe("bearer");
  });
});

describe("resolveProviderWire — authHeaderStyle override", () => {
  it("zai-coding-cn: anthropic-messages family but Bearer via wire override", () => {
    const route = makeRoute({ providerId: "zai-coding-cn", apiFamily: "anthropic-messages", wire: { authHeaderStyle: "bearer", headers: [] } });
    expect(resolveProviderWire(route, {}).headerStyle).toBe("bearer");
  });
});

describe("resolveProviderWire — resolved metadata headers", () => {
  it("literal headers pass through", () => {
    const route = makeRoute({ wire: { headers: [{ header: "OpenAI-Beta", literal: "responses=experimental" }, { header: "originator", literal: "codex_cli_rs" }] } });
    const wire = resolveProviderWire(route, {});
    expect(wire.extraHeaders["OpenAI-Beta"]).toBe("responses=experimental");
    expect(wire.extraHeaders["originator"]).toBe("codex_cli_rs");
  });

  it("env-var header wins over fallback", () => {
    const route = makeRoute({ wire: { headers: [{ header: "x-grok-client-version", envVar: "GROK_VERSION", fallback: "0.1.202" }] } });
    expect(resolveProviderWire(route, { GROK_VERSION: "0.9.9" }).extraHeaders["x-grok-client-version"]).toBe("0.9.9");
  });

  it("falls back when no source resolves", () => {
    const route = makeRoute({ wire: { headers: [{ header: "x-grok-client-version", filePath: "~/.grok/version.json", jsonPath: "version", fallback: "0.1.202" }] } });
    const wire = resolveProviderWire(route, {}, { readFile: () => { throw new Error("ENOENT"); } });
    expect(wire.extraHeaders["x-grok-client-version"]).toBe("0.1.202");
  });

  it("reads a header value from an ecosystem file via dot-path", () => {
    const route = makeRoute({ wire: { headers: [{ header: "ChatGPT-Account-Id", filePath: "~/.codex/auth.json", jsonPath: "tokens.account_id" }] } });
    const wire = resolveProviderWire(route, {}, { readFile: () => JSON.stringify({ tokens: { account_id: "acct-uuid-123" } }) });
    expect(wire.extraHeaders["ChatGPT-Account-Id"]).toBe("acct-uuid-123");
  });

  it("supports the '*' wildcard for dynamic-keyed files (grok version shape not needed, but wildcard works)", () => {
    const route = makeRoute({ wire: { headers: [{ header: "x-token-hint", filePath: "~/.x/session.json", jsonPath: "*.hint" }] } });
    const wire = resolveProviderWire(route, {}, { readFile: () => JSON.stringify({ "session::abc": { hint: "abc-hint" } }) });
    expect(wire.extraHeaders["x-token-hint"]).toBe("abc-hint");
  });

  it("no wire = no extra headers, family default style", () => {
    const route = makeRoute({ providerId: "openai" });
    const wire = resolveProviderWire(route, {});
    expect(wire.extraHeaders).toEqual({});
    expect(wire.headerStyle).toBe("bearer");
  });

  it("aws-bedrock-oai keeps OpenAI-Project until it declares wire", () => {
    const route = makeRoute({ providerId: "aws-bedrock-oai" });
    expect(resolveProviderWire(route, {}).extraHeaders["OpenAI-Project"]).toBe("default");
  });
});
