import { afterEach, describe, expect, it } from "vitest";

import {
  assertSecretSafeStrings,
  clearRegisteredSecretValues,
  containsSecretValue,
  registerSecretValue,
  scrubRegisteredSecretValues,
  scrubSecretValues
} from "../../src/safety/secretSafety.js";

afterEach(() => {
  clearRegisteredSecretValues();
});

describe("secretSafety — shape patterns", () => {
  it("redacts token-shaped strings regardless of registration", () => {
    const samples = [
      "sk-abcdefghijklmnop1234",
      "ghp_ABCDEFGHIJKLMNOPQRST12345",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4",
      "Bearer abc.def-ghi_jkl"
    ];
    for (const sample of samples) {
      const scrubbed = scrubSecretValues(`error near ${sample} end`);
      expect(scrubbed).not.toContain(sample);
      expect(scrubbed).toContain("[redacted:");
    }
  });

  it("leaves ordinary text untouched", () => {
    const text = "Missing env var: ZAI_API_KEY. Tried: env (ZAI_API_KEY) -> op-probe (AGENTS-OS/ZAI_API_KEY).";
    expect(scrubSecretValues(text)).toBe(text);
  });
});

describe("secretSafety — registered-value redaction", () => {
  it("scrubs an exact resolved value even when it matches no shape", () => {
    registerSecretValue("plainlookingvalue42");
    const scrubbed = scrubSecretValues("failed with key plainlookingvalue42 rejected");
    expect(scrubbed).not.toContain("plainlookingvalue42");
    expect(scrubbed).toContain("[redacted:credential]");
  });

  it("scrubRegisteredSecretValues does NOT apply shape patterns (transcript mode)", () => {
    registerSecretValue("resolved-secret-value-1");
    const text = "user typed sk-abcdefghijklmnop1234 while resolved-secret-value-1 was live";
    const scrubbed = scrubRegisteredSecretValues(text);
    expect(scrubbed).toContain("sk-abcdefghijklmnop1234"); // user content stays
    expect(scrubbed).not.toContain("resolved-secret-value-1"); // our value never persists
  });

  it("ignores values shorter than the registration floor", () => {
    registerSecretValue("short");
    expect(scrubSecretValues("short text short")).toBe("short text short");
  });
});

describe("secretSafety — assertions", () => {
  it("throws value-free on shape hit", () => {
    expect(() => assertSecretSafeStrings(["endpoint sk-abcdefghijklmnop1234"], "test surface")).toThrowError(
      /test surface failed secret-safety scan: pattern/
    );
    try {
      assertSecretSafeStrings(["endpoint sk-abcdefghijklmnop1234"], "test surface");
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-abcdefghijklmnop1234");
    }
  });

  it("throws value-free when a registered value leaks into metadata", () => {
    registerSecretValue("resolved-credential-xyz");
    try {
      assertSecretSafeStrings(["docs say resolved-credential-xyz"], "metadata");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("metadata failed secret-safety scan");
      expect((error as Error).message).not.toContain("resolved-credential-xyz");
    }
  });

  it("containsSecretValue detects both modes", () => {
    expect(containsSecretValue("ghp_ABCDEFGHIJKLMNOPQRST12345")).toBe(true);
    registerSecretValue("innocuous-token-value");
    expect(containsSecretValue("x innocuous-token-value y")).toBe(true);
    expect(containsSecretValue("nothing here")).toBe(false);
  });
});
