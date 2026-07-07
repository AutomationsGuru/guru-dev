import { describe, expect, it } from "vitest";

import { defineProviderRoute } from "../../src/providers/registry.js";
import {
  getOperatorAuthSpec,
  isOperatorAuthRoute,
  resolveOperatorAuthPresence,
  OPERATOR_AUTH_SPECS
} from "../../src/model/operatorAuth.js";

// A generic operator-auth (oauth-cache) route fixture — the CLI-delegate concept
// (and its native-cli-token codex lane) was removed 2026-07; both plan providers that
// used to delegate are now guru-native OAuth (guru-oauth) or plain API keys.
const route = (providerId: string, filePath: string) =>
  defineProviderRoute({
    providerId,
    modelId: "m",
    routeId: `${providerId}/m`,
    routeType: "operator-provider-plan-auth",
    apiFamily: "openai-responses",
    credentialSource: { type: "oauth-cache", filePath, cacheTokenPath: "x", envVarNames: [] },
    status: "active",
    directFirstRank: 1,
    allowedRouterFallback: false
  });

describe("operator auth presence (path only)", () => {
  it("classifies plan-auth / oauth-cache routes as operator-auth", () => {
    expect(isOperatorAuthRoute(route("grok", "~/.grok/auth.json"))).toBe(true);
  });

  it("reports present when the credential cache exists — value never surfaced", () => {
    const presence = resolveOperatorAuthPresence(route("grok", "~/.grok/auth.json"), {
      home: "/home/op",
      filesExist: (abs) => abs.replace(/\\/gu, "/") === "/home/op/.grok/auth.json"
    });

    expect(presence.present).toBe(true);
    expect(presence.presentPath).toBe(".grok/auth.json");
    expect(JSON.stringify(presence)).not.toContain("auth-token");
    expect(JSON.stringify(presence)).not.toContain("secret");
  });

  it("reports login-needed with the exact login command when the cache is absent", () => {
    const presence = resolveOperatorAuthPresence(route("grok", "~/.grok/auth.json"), { home: "/home/op", filesExist: () => false });

    expect(presence.present).toBe(false);
    expect(presence.loginCommand).toBe("grok auth");
    expect(presence.summary).toContain("grok auth");
  });
});

describe("operator-auth spec ↔ catalog consistency (the login-status split-brain fix)", () => {
  it("openai-codex (the ChatGPT plan lane) shares the codex login file for presence display", () => {
    const spec = getOperatorAuthSpec("openai-codex");
    expect(spec?.cacheRelPaths).toEqual([".codex/auth.json"]);
    const present = resolveOperatorAuthPresence(route("openai-codex", "~/.codex/auth.json"), {
      home: "/home/op",
      filesExist: (abs) => abs.replace(/\\/gu, "/") === "/home/op/.codex/auth.json"
    });
    expect(present.supported).toBe(true);
    expect(present.present).toBe(true);
  });

  it("INVARIANT: every plan spec that maps to a cache-backed catalog route checks that route's credential file", () => {
    const CATALOG_FILE: Record<string, string> = {
      "openai-codex": ".codex/auth.json",
      "grok": ".grok/auth.json"
    };
    for (const [providerId, rel] of Object.entries(CATALOG_FILE)) {
      const spec = getOperatorAuthSpec(providerId);
      expect(spec, providerId).toBeDefined();
      expect(spec?.cacheRelPaths, providerId).toContain(rel);
    }
  });

  it("NO spec carries a CLI delegate anymore — guru never delegates a turn to a provider CLI", () => {
    for (const spec of OPERATOR_AUTH_SPECS) {
      expect(spec, spec.providerId).not.toHaveProperty("delegate");
    }
  });
});
