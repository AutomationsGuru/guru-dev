import { describe, expect, it } from "vitest";

import { createDirectProviderCatalog } from "../../src/providers/catalog.js";

describe("openai-codex — the ChatGPT plan lane (native OAuth, no CLI delegate)", () => {
  const catalog = createDirectProviderCatalog();

  it("exposes openai-codex routes and NO CLI-delegate lane anywhere", () => {
    const codex = catalog.filter((route) => route.providerId === "openai-codex");
    expect(codex.length).toBe(2);
    expect(codex.every((route) => route.routeType === "operator-provider-plan-auth")).toBe(true);
    // The old CLI-delegate lane (credentialSource native-cli-token) is gone entirely.
    expect(catalog.some((route) => route.credentialSource.type === "native-cli-token")).toBe(false);
  });

  it("wires the Responses endpoint via guru's OWN vaulted OAuth token — no ~/.codex cache", () => {
    const route = catalog.find((candidate) => candidate.routeId === "openai-codex/gpt-5.6-sol");
    expect(route).toBeDefined();
    expect(route?.apiFamily).toBe("openai-responses");
    expect(route?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(route?.credentialSource.type).toBe("guru-oauth"); // guru's own sign-in, not a cache
    expect(route?.credentialSource.filePath).toBeUndefined(); // NEVER reads ~/.codex/auth.json
    expect(route?.status).toBe("active");
    const headers = route?.wire?.headers ?? [];
    expect(headers.map((header) => header.header)).toEqual(expect.arrayContaining(["ChatGPT-Account-Id", "OpenAI-Beta", "originator"]));
    const accountHeader = headers.find((header) => header.header === "ChatGPT-Account-Id");
    expect(accountHeader?.oauthAccount).toBe(true);
    expect(accountHeader?.filePath).toBeUndefined();
  });

  it("openai-codex/gpt-5.6-sol is the #1 auto-connect pick", () => {
    const sorted = [...catalog].sort((a, b) => (a.directFirstRank ?? 999) - (b.directFirstRank ?? 999));
    expect(sorted[0]?.routeId).toBe("openai-codex/gpt-5.6-sol");
  });

  it("grok carries its Phase B wire; zai-coding flipped active on probe", () => {
    const grok = catalog.find((route) => route.providerId === "grok");
    expect(grok?.wire?.headers.some((header) => header.header === "x-grok-client-version")).toBe(true);
    const zai = catalog.find((route) => route.providerId === "zai-coding");
    expect(zai?.wire?.authHeaderStyle).toBe("bearer");
    expect(zai?.status).toBe("active");
  });
});
