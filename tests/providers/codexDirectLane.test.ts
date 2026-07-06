import { describe, expect, it } from "vitest";

import { createDirectProviderCatalog } from "../../src/providers/catalog.js";

describe("codex-direct lane (Phase B) — second route beside the delegate", () => {
  const catalog = createDirectProviderCatalog();

  it("adds openai-codex-direct routes WITHOUT touching the delegate lane", () => {
    const direct = catalog.filter((route) => route.providerId === "openai-codex-direct");
    const delegate = catalog.filter((route) => route.providerId === "openai-codex");
    expect(direct.length).toBe(2);
    expect(delegate.length).toBeGreaterThan(0); // delegate still present
    expect(delegate.every((route) => route.routeType === "operator-provider-plan-auth")).toBe(true);
  });

  it("wires the Responses endpoint + ecosystem token + headers, status needs-login (not flipped)", () => {
    const route = catalog.find((candidate) => candidate.routeId === "openai-codex-direct/gpt-5.5");
    expect(route).toBeDefined();
    expect(route?.apiFamily).toBe("openai-responses");
    expect(route?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(route?.credentialSource.filePath).toBe("~/.codex/auth.json");
    expect(route?.credentialSource.cacheTokenPath).toBe("tokens.access_token");
    expect(route?.credentialSource.oauthPolicy).toBe("ecosystem-ok");
    expect(route?.status).toBe("active"); // flipped 2026-07-04 (Finale): chat PASS after stream-backfill fix
    const headerNames = (route?.wire?.headers ?? []).map((header) => header.header);
    expect(headerNames).toContain("ChatGPT-Account-Id");
    expect(headerNames).toContain("OpenAI-Beta");
    expect(headerNames).toContain("originator");
  });

  it("grok-cli carries its Phase B wire but stays unflipped (401 auth shape); zai flipped active on probe", () => {
    const grok = catalog.find((route) => route.providerId === "grok-cli");
    expect(grok?.wire?.headers.some((header) => header.header === "x-grok-client-version")).toBe(true);
    expect(grok?.status).toBe("delegated"); // not flipped — probe 401
    const zai = catalog.find((route) => route.providerId === "zai-coding-cn");
    expect(zai?.wire?.authHeaderStyle).toBe("bearer");
    expect(zai?.status).toBe("active"); // flipped on live probe pass
  });
});
