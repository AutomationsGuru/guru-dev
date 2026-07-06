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

  it("wires the Responses endpoint via guru's OWN vaulted OAuth token — no ~/.codex cache", () => {
    const route = catalog.find((candidate) => candidate.routeId === "openai-codex-direct/gpt-5.5");
    expect(route).toBeDefined();
    expect(route?.apiFamily).toBe("openai-responses");
    expect(route?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(route?.credentialSource.type).toBe("guru-oauth"); // guru's own sign-in, not a cache
    expect(route?.credentialSource.filePath).toBeUndefined(); // NEVER reads ~/.codex/auth.json
    expect(route?.status).toBe("active");
    const headers = route?.wire?.headers ?? [];
    expect(headers.map((header) => header.header)).toEqual(expect.arrayContaining(["ChatGPT-Account-Id", "OpenAI-Beta", "originator"]));
    // the account id is sourced from guru's vaulted token, not a cache file
    const accountHeader = headers.find((header) => header.header === "ChatGPT-Account-Id");
    expect(accountHeader?.oauthAccount).toBe(true);
    expect(accountHeader?.filePath).toBeUndefined();
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
