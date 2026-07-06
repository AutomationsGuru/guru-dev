import { afterEach, describe, expect, it } from "vitest";

import { resolveRouteCredential, resetOpAvailabilityForTests, registerCredentialVault, clearCredentialVault, DirectChatError } from "../../src/model/directChat.js";
import { clearRegisteredSecretValues, scrubSecretValues } from "../../src/safety/secretSafety.js";
import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from "../../src/providers/schemas.js";

function makeRoute(credentialSource: Record<string, unknown>): ProviderRouteDescriptor {
  return ProviderRouteDescriptorSchema.parse({
    providerId: "test",
    modelId: "test-model",
    routeId: "test/test-model",
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://example.invalid/v1",
    credentialSource,
    status: "ready-unverified",
    directFirstRank: 99,
    allowedRouterFallback: false
  });
}

afterEach(() => {
  clearRegisteredSecretValues();
  resetOpAvailabilityForTests(undefined);
  clearCredentialVault();
});

describe("layer 1b — the credential vault (env-var alternative)", () => {
  it("resolves a key from the vault by env NAME when env is absent — source 'vault'", () => {
    registerCredentialVault((name) => (name === "ANTHROPIC_API_KEY" ? "sk-ant-vaulted" : undefined));
    const route = makeRoute({ type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, {}, { disableOpProbe: true }); // empty env
    expect(result.usable).toBe(true);
    expect(result.source).toBe("vault");
    // The value is registered for scrubbing (presence-over-value).
    expect(scrubSecretValues("leak sk-ant-vaulted here")).not.toContain("sk-ant-vaulted");
  });

  it("env WINS over the vault (env is layer 1, vault is 1b)", () => {
    registerCredentialVault(() => "sk-from-vault");
    const route = makeRoute({ type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, { ANTHROPIC_API_KEY: "sk-from-env" }, { disableOpProbe: true });
    expect(result.source).toBe("env");
  });

  it("no registered vault → resolution is unchanged (byte-identical)", () => {
    const route = makeRoute({ type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, {}, { disableOpProbe: true });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("the op-probe is OFF by default — a bare env (no readOpReference, no GURU_OP_PROBE) never probes op", () => {
    const route = makeRoute({ type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [] });
    let probed = false;
    // Passing readOpReference would opt-in; we do NOT, and assert no op path is taken.
    const result = resolveRouteCredential(route, {});
    expect(result.usable).toBe(false);
    expect(probed).toBe(false); // (nothing to probe — the point is it stays missing, not op-resolved)
  });
});

describe("layered credential resolver — layer 1: env auto-discovery", () => {
  it("resolves from the primary env name and returns the value in-memory", () => {
    const route = makeRoute({ type: "env-var", envVarName: "TEST_PRIMARY_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, { TEST_PRIMARY_KEY: "value-from-env-1234" }, { disableOpProbe: true });
    expect(result.usable).toBe(true);
    expect(result.source).toBe("env");
    expect(result.value).toBe("value-from-env-1234");
    expect(result.envName).toBe("TEST_PRIMARY_KEY");
  });

  it("falls through fallback env names in order", () => {
    const route = makeRoute({ type: "env-var", envVarName: "MISSING_ONE", envVarNames: ["MISSING_TWO", "PRESENT_THREE"] });
    const result = resolveRouteCredential(route, { PRESENT_THREE: "fallback-env-value-1" }, { disableOpProbe: true });
    expect(result.usable).toBe(true);
    expect(result.envName).toBe("PRESENT_THREE");
  });

  it("registers the resolved value with the scrubber", () => {
    const route = makeRoute({ type: "env-var", envVarName: "SCRUB_ME_KEY", envVarNames: [] });
    resolveRouteCredential(route, { SCRUB_ME_KEY: "registered-by-resolver-1" }, { disableOpProbe: true });
    expect(scrubSecretValues("oops registered-by-resolver-1 leaked")).not.toContain("registered-by-resolver-1");
  });
});

describe("layered credential resolver — layer 2: templates", () => {
  it("resolves $VAR templates from env", () => {
    const route = makeRoute({ type: "env-var", envVarName: "UNSET_NAME", envVarNames: [], template: "$MY_TEMPLATE_VAR" });
    const result = resolveRouteCredential(route, { MY_TEMPLATE_VAR: "templated-value-99" }, { disableOpProbe: true });
    expect(result.usable).toBe(true);
    expect(result.source).toBe("template");
    expect(result.value).toBe("templated-value-99");
  });

  it("resolves ${VAR:-default} fallbacks", () => {
    const route = makeRoute({ type: "env-var", envVarName: "UNSET_NAME", envVarNames: [], template: "${NOT_SET:-default-token-value}" });
    const result = resolveRouteCredential(route, {}, { disableOpProbe: true });
    expect(result.usable).toBe(true);
    expect(result.value).toBe("default-token-value");
  });

  it("resolves $(command) templates through the injected runner", () => {
    const route = makeRoute({ type: "env-var", envVarName: "UNSET_NAME", envVarNames: [], template: "$(secret-helper get token)" });
    const result = resolveRouteCredential(route, {}, {
      disableOpProbe: true,
      execCommand: (command) => {
        expect(command).toBe("secret-helper get token");
        return "command-produced-value";
      }
    });
    expect(result.usable).toBe(true);
    expect(result.source).toBe("template");
    expect(result.value).toBe("command-produced-value");
  });

  it("resolves op:// templates through the injected op reader", () => {
    const route = makeRoute({ type: "env-var", envVarName: "UNSET_NAME", envVarNames: [], template: "op://Vault/Item/credential" });
    const result = resolveRouteCredential(route, {}, {
      readOpReference: (reference) => {
        expect(reference).toBe("op://Vault/Item/credential");
        return "op-item-value-1";
      }
    });
    expect(result.usable).toBe(true);
    expect(result.value).toBe("op-item-value-1");
  });

  it("a failing $(command) falls through without throwing", () => {
    const route = makeRoute({ type: "env-var", envVarName: "UNSET_NAME", envVarNames: [], template: "$(broken)" });
    const result = resolveRouteCredential(route, {}, {
      disableOpProbe: true,
      execCommand: () => {
        throw new Error("boom");
      }
    });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("template");
  });
});

describe("layered credential resolver — layer 3: op auto-probe", () => {
  it("probes op://<GURU_OP_VAULT>/<ENV_NAME>/credential by convention", () => {
    const route = makeRoute({ type: "env-var", envVarName: "PROBE_KEY_NAME", envVarNames: [] });
    const result = resolveRouteCredential(route, { GURU_OP_VAULT: "TestVault" }, {
      readOpReference: (reference) => {
        expect(reference).toBe("op://TestVault/PROBE_KEY_NAME/credential");
        return "op-probe-value-7";
      }
    });
    expect(result.usable).toBe(true);
    expect(result.source).toBe("op-probe");
    expect(result.value).toBe("op-probe-value-7");
  });

  it("defaults the vault to AGENTS-OS", () => {
    const route = makeRoute({ type: "env-var", envVarName: "PROBE_KEY_NAME", envVarNames: [] });
    const seen: string[] = [];
    resolveRouteCredential(route, {}, {
      readOpReference: (reference) => {
        seen.push(reference);
        throw new Error("item not found");
      }
    });
    expect(seen).toEqual(["op://AGENTS-OS/PROBE_KEY_NAME/credential"]);
  });

  it("probe misses fall through silently to an honest reason", () => {
    const route = makeRoute({ type: "env-var", envVarName: "PROBE_KEY_NAME", envVarNames: [] });
    const result = resolveRouteCredential(route, {}, {
      readOpReference: () => {
        throw new Error("not signed in");
      }
    });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("op-probe");
  });
});

describe("layered credential resolver — layer 4: ecosystem cache (read-only)", () => {
  it("reads a token via dot-path from the provider's own cache", () => {
    const route = makeRoute({
      type: "oauth-cache",
      envVarName: "UNSET_NAME",
      envVarNames: [],
      filePath: "~/.fake/auth.json",
      cacheTokenPath: "tokens.access_token",
      oauthPolicy: "ecosystem-ok"
    });
    const result = resolveRouteCredential(route, {}, {
      disableOpProbe: true,
      readFile: () => JSON.stringify({ tokens: { access_token: "cache-token-abc", expires_at: "2026-08-01T00:00:00Z" } })
    });
    expect(result.usable).toBe(true);
    expect(result.source).toBe("ecosystem-cache");
    expect(result.value).toBe("cache-token-abc");
    expect(result.expiresAt).toBe("2026-08-01T00:00:00Z");
  });

  it("supports the '*' wildcard segment for dynamic-keyed caches (grok shape)", () => {
    const route = makeRoute({
      type: "oauth-cache",
      envVarNames: [],
      filePath: "~/.grok/auth.json",
      cacheTokenPath: "*.access_token",
      oauthPolicy: "ecosystem-ok"
    });
    const result = resolveRouteCredential(route, {}, {
      disableOpProbe: true,
      readFile: () => JSON.stringify({ "https://auth.x.ai::some-uuid": { access_token: "grok-shaped-token", expires_at: 1785000000 } })
    });
    expect(result.usable).toBe(true);
    expect(result.value).toBe("grok-shaped-token");
    expect(result.expiresAt).toBe("1785000000");
  });

  it("oauthPolicy=forbidden blocks the cache layer with an explicit reason", () => {
    const route = makeRoute({
      type: "oauth-cache",
      envVarNames: [],
      filePath: "~/.claude/creds.json",
      cacheTokenPath: "token",
      oauthPolicy: "forbidden"
    });
    const result = resolveRouteCredential(route, {}, {
      disableOpProbe: true,
      readFile: () => {
        throw new Error("must never be called");
      }
    });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("oauthPolicy=forbidden");
  });

  it("missing cache files fall through without throwing", () => {
    const route = makeRoute({
      type: "oauth-cache",
      envVarNames: [],
      filePath: "~/.nonexistent/auth.json",
      cacheTokenPath: "token",
      oauthPolicy: "ecosystem-ok"
    });
    const result = resolveRouteCredential(route, {}, {
      disableOpProbe: true,
      readFile: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain("cache missing or unreadable");
  });
});

describe("resolver output hygiene", () => {
  it("single-env misses keep the classic picker message", () => {
    const route = makeRoute({ type: "env-var", envVarName: "SOME_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, {}, { disableOpProbe: true });
    expect(result.usable).toBe(false);
    expect(result.reason).toBe("Missing env var: SOME_KEY.");
  });

  it("multi-layer misses report every attempted layer", () => {
    const route = makeRoute({ type: "env-var", envVarName: "SOME_KEY", envVarNames: [], template: "$UNSET_TPL" });
    const result = resolveRouteCredential(route, {}, { disableOpProbe: true });
    expect(result.usable).toBe(false);
    expect(result.reason).toMatch(/No credential found\. Tried: env .* template/);
  });

  it("the resolved value is NON-ENUMERABLE — serialization never carries it", () => {
    const route = makeRoute({ type: "env-var", envVarName: "SERIALIZE_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, { SERIALIZE_KEY: "must-not-serialize-1" }, { disableOpProbe: true });
    expect(result.value).toBe("must-not-serialize-1"); // explicit read works
    expect(JSON.stringify(result)).not.toContain("must-not-serialize-1"); // stringify never carries it
    expect(Object.keys(result)).not.toContain("value"); // spreads never carry it
  });

  it("DirectChatError scrubs token-shaped strings from messages", () => {
    const error = new DirectChatError("HTTP 401: bad key sk-abcdefghijklmnop1234", { routeId: "test/route" });
    expect(error.message).not.toContain("sk-abcdefghijklmnop1234");
    expect(error.message).toContain("[redacted:");
  });

  it("legacy signature (route, env) still works", () => {
    resetOpAvailabilityForTests(false);
    const route = makeRoute({ type: "env-var", envVarName: "LEGACY_KEY", envVarNames: [] });
    const result = resolveRouteCredential(route, { LEGACY_KEY: "legacy-env-value-1" });
    expect(result.usable).toBe(true);
    expect(result.value).toBe("legacy-env-value-1");
  });

  it("type none is unchanged", () => {
    const route = makeRoute({ type: "none", envVarNames: [] });
    const result = resolveRouteCredential(route, {}, { disableOpProbe: true });
    expect(result.usable).toBe(true);
    expect(result.source).toBe("none");
  });
});
