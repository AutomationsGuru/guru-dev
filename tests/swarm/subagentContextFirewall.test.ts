import { describe, expect, it } from "vitest";

import {
  filterContext,
  ALWAYS_DENIED_KEYS,
  type SubagentContext
} from "../../src/swarm/subagentContextFirewall.js";

describe("subagent context firewall — allowlist-only forwarding", () => {
  it("passes only explicitly allowlisted keys", () => {
    const ctx: SubagentContext = {
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are a helper.",
      apiKey: "sk-secret-123",
      toolResults: [{ callId: "c1", output: "ok" }]
    };
    const result = filterContext(ctx, ["messages", "systemPrompt"]);
    expect(result).toHaveProperty("messages");
    expect(result).toHaveProperty("systemPrompt");
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("toolResults");
  });

  it("returns an empty object when no keys are allowlisted", () => {
    const ctx: SubagentContext = {
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "prompt"
    };
    const result = filterContext(ctx, []);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns an empty object when allowlist keys are not present in context", () => {
    const ctx: SubagentContext = {
      messages: [{ role: "user", content: "hi" }]
    };
    const result = filterContext(ctx, ["systemPrompt", "toolResults"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles an empty context object", () => {
    const result = filterContext({}, ["messages"]);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("subagent context firewall — hard-denied keys (structural enforcement)", () => {
  it("ALWAYS strips secret-pattern keys even when explicitly allowlisted", () => {
    const ctx: SubagentContext = {
      messages: [{ role: "user", content: "query" }],
      apiKey: "sk-abc123",
      secret: "shh",
      password: "s3cret!",
      token: "bearer-xyz",
      credential: "creds-here",
      authorization: "Bearer tok",
      accessKey: "AKIA123",
      access_key: "akia456",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
      private_key: "-----BEGIN EC PRIVATE KEY-----"
    };

    const result = filterContext(ctx, [
      "messages",
      "apiKey",
      "secret",
      "password",
      "token",
      "credential",
      "authorization",
      "accessKey",
      "access_key",
      "privateKey",
      "private_key"
    ]);

    // messages is allowlisted and NOT in denied set → passes
    expect(result).toHaveProperty("messages");

    // Every secret-pattern key is stripped despite being allowlisted
    for (const denied of ALWAYS_DENIED_KEYS) {
      expect(result).not.toHaveProperty(denied);
    }
  });

  it("strips secret keys even when they are the ONLY allowlisted keys", () => {
    const ctx: SubagentContext = {
      apiKey: "sk-top-secret",
      token: "jwt-here"
    };
    const result = filterContext(ctx, ["apiKey", "token"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("preserves non-secret camelCase and snake_case keys when allowlisted", () => {
    const ctx: SubagentContext = {
      messages: [{ role: "user", content: "x" }],
      systemPrompt: "be helpful",
      tool_results: [{ callId: "c1", output: "ok" }],
      modelConfig: { temperature: 0.7 },
      maxTokens: 4096
    };
    const result = filterContext(ctx, [
      "messages",
      "systemPrompt",
      "tool_results",
      "modelConfig",
      "maxTokens"
    ]);
    expect(result).toHaveProperty("messages");
    expect(result).toHaveProperty("systemPrompt");
    expect(result).toHaveProperty("tool_results");
    expect(result).toHaveProperty("modelConfig");
    expect(result).toHaveProperty("maxTokens");
  });
});

describe("subagent context firewall — ALWAYS_DENIED_KEYS is frozen and immutable", () => {
  it("the denied set cannot be mutated at runtime", () => {
    expect(Object.isFrozen(ALWAYS_DENIED_KEYS)).toBe(true);
  });

  it("the denied set covers all expected secret patterns", () => {
    const expected = [
      "apiKey",
      "api_key",
      "secret",
      "secrets",
      "password",
      "passwords",
      "token",
      "tokens",
      "credential",
      "credentials",
      "authorization",
      "accessKey",
      "access_key",
      "privateKey",
      "private_key"
    ];
    for (const key of expected) {
      expect(ALWAYS_DENIED_KEYS.has(key)).toBe(true);
    }
  });
});

describe("subagent context firewall — type safety", () => {
  it("filterContext preserves value types for allowlisted keys", () => {
    const ctx: SubagentContext = {
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "hi there" }
      ],
      maxTokens: 8192
    };
    const result = filterContext(ctx, ["messages", "maxTokens"]);
    const msgs = result.messages as Array<{ role: string; content: string }> | undefined;
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs).toHaveLength(2);
    expect(msgs?.[0]?.role).toBe("user");
    expect(typeof result.maxTokens).toBe("number");
    expect(result.maxTokens).toBe(8192);
  });

  it("does not mutate the original context object", () => {
    const ctx: SubagentContext = {
      messages: [{ role: "user", content: "original" }],
      apiKey: "sk-secret"
    };
    const snapshot = { ...ctx };
    filterContext(ctx, ["messages"]);
    expect(ctx).toEqual(snapshot);
  });
});
