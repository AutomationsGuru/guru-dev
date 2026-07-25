import { describe, expect, it } from "vitest";

import {
  expandMcpServerConfigSecrets,
  expandSecretRefs,
  type SecretExpansionError
} from '../../src/mcp/secretExpand.js';
import { McpServerConfigSchema } from '../../src/mcp/schemas.js';
import { clearRegisteredSecretValues, scrubSecretValues } from '../../src/safety/secretSafety.js';

/**
 * Secret constitution coverage (§3.3): expansion is env-only, presence/names
 * flow through results, and no error path may echo an env VALUE back.
 */

const ENV = { FAKE_MCP_KEY: "super-sensitive-test-value" };

describe("expandSecretRefs — env-only expansion", () => {
  it("expands $VAR and ${VAR} forms", () => {
    const result = expandSecretRefs("token=$FAKE_MCP_KEY", ENV);
    expect(result).toEqual({ ok: true, text: "token=super-sensitive-test-value" });
    expect(expandSecretRefs("${FAKE_MCP_KEY}", ENV)).toEqual({ ok: true, text: "super-sensitive-test-value" });
  });

  it("expands ${VAR:?message} when the variable is present", () => {
    expect(expandSecretRefs("${FAKE_MCP_KEY:?need the key}", ENV)).toEqual({ ok: true, text: "super-sensitive-test-value" });
  });

  it("errors with NAME + custom message when ${VAR:?message} is unset — never a value", () => {
    const result = expandSecretRefs("${FAKE_MCP_MISSING:?set the key first}", ENV);
    expect(result).toEqual({ ok: false, error: "FAKE_MCP_MISSING: set the key first" });
  });

  it("errors with the variable NAME (not any value) when $VAR / ${VAR} is unset", () => {
    expect(expandSecretRefs("$FAKE_MCP_MISSING", ENV)).toEqual({
      ok: false,
      error: "FAKE_MCP_MISSING is not set (referenced by secret expansion)"
    });
    const braced = expandSecretRefs("${FAKE_MCP_MISSING}", ENV);
    expect(braced).toEqual({ ok: false, error: "FAKE_MCP_MISSING is not set (referenced by secret expansion)" });
  });

  it("never embeds a resolved env value in an error string", () => {
    // The value sits adjacent to the failure site; the error must name the
    // missing variable only — the present value must not leak through it.
    const result = expandSecretRefs("${FAKE_MCP_KEY}-suffix-${FAKE_MCP_MISSING}", ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(ENV.FAKE_MCP_KEY);
      expect(result.error).toContain("FAKE_MCP_MISSING");
    }
  });

  it("treats an empty env value as unset for required and optional expansion", () => {
    expect(expandSecretRefs("$FAKE_MCP_KEY", { FAKE_MCP_KEY: "" })).toEqual({
      ok: false,
      error: "FAKE_MCP_KEY is not set (referenced by secret expansion)"
    });
    expect(expandSecretRefs("${FAKE_MCP_KEY:?must be non-empty}", { FAKE_MCP_KEY: "" })).toEqual({
      ok: false,
      error: "FAKE_MCP_KEY: must be non-empty"
    });
  });

  it("expands several references in one string and leaves literals alone", () => {
    const result = expandSecretRefs("a=$FAKE_MCP_KEY b=${FAKE_MCP_KEY} c=plain", ENV);
    expect(result).toEqual({ ok: true, text: "a=super-sensitive-test-value b=super-sensitive-test-value c=plain" });
  });

  it("never performs shell expansion — $(...) and backticks stay literal", () => {
    // Untrusted project config must not gain command execution (plan exclusion).
    expect(expandSecretRefs("$(touch /tmp/guru-pwned)", {})).toEqual({ ok: true, text: "$(touch /tmp/guru-pwned)" });
    expect(expandSecretRefs("`id`", {})).toEqual({ ok: true, text: "`id`" });
  });

  it("rejects references to malformed env names instead of guessing", () => {
    const result = expandSecretRefs("${not-a-name}", ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not a valid environment variable name");
    }
  });
});

describe("expandMcpServerConfigSecrets — scrubbed config view", () => {
  function httpConfig(overrides: Record<string, unknown> = {}) {
    return McpServerConfigSchema.parse({
      id: "fake",
      transport: "http",
      url: "https://example.com/mcp",
      category: "test",
      ...overrides
    });
  }

  it("expands url and args while leaving other fields untouched", () => {
    const config = httpConfig({ url: "https://$FAKE_MCP_KEY.example.com/mcp", args: ["--key=$FAKE_MCP_KEY", "literal"] });
    const result = expandMcpServerConfigSecrets(config, ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.url).toBe("https://super-sensitive-test-value.example.com/mcp");
      expect(result.config.args).toEqual(["--key=super-sensitive-test-value", "literal"]);
      expect(result.config.id).toBe("fake");
      expect(result.config.transport).toBe("http");
    }
  });

  it("registers expanded values with the secret scrubber so printable paths redact them", () => {
    clearRegisteredSecretValues();
    try {
      const config = httpConfig({ url: "https://$FAKE_MCP_KEY.example.com/mcp" });
      const result = expandMcpServerConfigSecrets(config, ENV);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.url).not.toContain("$FAKE_MCP_KEY");
      }
      // Structural guarantee (§3.3): the materialized value is registered at the
      // choke point, so ANY later printable path (error, log, transcript) redacts it.
      const printable = scrubSecretValues(`connecting to ${ENV.FAKE_MCP_KEY} failed`);
      expect(printable).not.toContain(ENV.FAKE_MCP_KEY);
      expect(printable).toContain("[redacted");
    } finally {
      clearRegisteredSecretValues();
    }
  });

  it("reports failure by env NAME and field path only — config value never in the error", () => {
    const config = httpConfig({ args: ["--key=${FAKE_MCP_MISSING:?configure it}"] });
    const result = expandMcpServerConfigSecrets(config, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("FAKE_MCP_MISSING");
      expect(result.error).toContain("args[0]");
      expect(result.error).not.toContain(ENV.FAKE_MCP_KEY);
    }
  });

  it("fails closed on the first unresolved reference (no partial expansion leaks)", () => {
    const config = httpConfig({ args: ["--a=$FAKE_MCP_MISSING", "--b=$FAKE_MCP_KEY"] });
    const result = expandMcpServerConfigSecrets(config, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(ENV.FAKE_MCP_KEY);
    }
  });

  it("is a pure view — the input config is not mutated", () => {
    const config = httpConfig({ args: ["--key=$FAKE_MCP_KEY"] });
    const before = structuredClone(config);
    expandMcpServerConfigSecrets(config, ENV);
    expect(config).toEqual(before);
  });

  it("returns a typed error shape consumers can branch on", () => {
    const result = expandMcpServerConfigSecrets(httpConfig({ url: "https://$FAKE_MCP_MISSING.example.com/mcp" }), ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error: SecretExpansionError = result;
      expect(error.error).toContain("url");
    }
  });
});
