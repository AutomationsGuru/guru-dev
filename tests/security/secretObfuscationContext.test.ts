import { afterEach, describe, expect, it } from "vitest";

import {
  clearObfuscationState,
  obfuscate,
  OBFUSCATED_PLACEHOLDER
} from '../../src/security/secretObfuscationContext.js';

afterEach(() => {
  clearObfuscationState();
});

describe("secretObfuscationContext.obfuscate — known shapes", () => {
  it("redacts an API key from text before context inject", () => {
    const text = "Use this key: sk-abcdefghijklmnop1234 for the request.";
    const out = obfuscate(text);
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
    expect(out).toContain(OBFUSCATED_PLACEHOLDER);
  });

  it("redacts multiple token shapes in one pass", () => {
    const text = "openai sk-abcdefghijklmnop1234 and ghp_ABCDEFGHIJKLMNOPQRST1234 here";
    const out = obfuscate(text);
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST1234");
  });

  it("leaves ordinary plain text untouched", () => {
    const text = "The config file is at ./config/default.json. Server is healthy.";
    expect(obfuscate(text)).toBe(text);
  });

  it("is a no-op on empty input", () => {
    expect(obfuscate("")).toBe("");
  });

  it("is idempotent", () => {
    const text = "leaked: sk-abcdefghijklmnop1234";
    const once = obfuscate(text);
    expect(obfuscate(once)).toBe(once);
  });
});

describe("secretObfuscationContext.obfuscate — caller-provided secrets", () => {
  it("redacts a caller-provided secret value even when it matches no shape", () => {
    const text = "Connection uses mycustomtokenXYZ to auth.";
    const out = obfuscate(text, { secrets: ["mycustomtokenXYZ"] });
    expect(out).not.toContain("mycustomtokenXYZ");
    expect(out).toContain(OBFUSCATED_PLACEHOLDER);
  });

  it("redacts an env-style value passed as a secret", () => {
    const text = "DATABASE_URL has pw=hunter2letmein99 in it.";
    const out = obfuscate(text, { secrets: ["hunter2letmein99"] });
    expect(out).not.toContain("hunter2letmein99");
  });

  it("ignores secrets shorter than the minimum length (noise guard)", () => {
    const text = "short token 'abc' appears here";
    const out = obfuscate(text, { secrets: ["abc"] });
    expect(out).toBe(text);
  });

  it("ignores empty/undefined secret entries", () => {
    const text = "sk-abcdefghijklmnop1234 and nothing else";
    const out = obfuscate(text, { secrets: ["", undefined as unknown as string] });
    expect(out).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("redacts a caller-provided RegExp pattern", () => {
    const text = "internal auth code AUTH-9988776655 ready";
    const out = obfuscate(text, { secrets: [/AUTH-\d{8,}/] });
    expect(out).not.toContain("9988776655");
    expect(out).toContain(OBFUSCATED_PLACEHOLDER);
  });
});

describe("secretObfuscationContext.obfuscate — never exposes secrets in report", () => {
  it("the returned report lists which secret KINDS fired, never values", () => {
    const text = "sk-abcdefghijklmnop1234 and custom mycustomtokenXYZ";
    const res = obfuscate(text, { secrets: ["mycustomtokenXYZ"], report: true });
    expect(res.text).not.toContain("sk-abcdefghijklmnop1234");
    expect(res.text).not.toContain("mycustomtokenXYZ");
    expect(Array.isArray(res.matched)).toBe(true);
    expect(res.matched.length).toBeGreaterThan(0);
    for (const m of res.matched) {
      expect(typeof m).toBe("string");
      expect(m).not.toContain("sk-");
      expect(m).not.toContain("mycustomtoken");
    }
  });
});
