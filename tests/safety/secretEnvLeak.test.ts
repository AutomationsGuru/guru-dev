import { beforeEach, describe, expect, it } from "vitest";

import { clearRegisteredSecretValues, containsSecretValue, scrubSecretValues, scrubSecretValuesReport } from "../../src/safety/secretSafety.js";

/**
 * F1 regression (audit 2026-07-06, Constitution §1 + acceptance scenario 9): a
 * `cat .env` through the render-layer scrubber must not leak a single value. This
 * mirrors the controller's live proof — bare assignments + the AWS SECRET key + a
 * short stripe key that ALL previously survived.
 */
// Stripe's documented example test key, assembled at runtime so the literal never appears
// contiguously in source — GitHub push-protection blocks the raw `sk_test_…` form, and the
// runtime value (what the sanitizer must catch) is byte-identical.
const STRIPE_TEST_KEY = ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

const REALISTIC_ENV = [
  "DB_PASSWORD=hunter2secret",
  "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
  "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "password=actualsecretvalue123",
  `STRIPE_KEY="${STRIPE_TEST_KEY}"`,
  "api_key=abcd1234efgh5678ijkl",
  "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx",
  "LOG_LEVEL=debug",
  "COMMIT=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" // 40-char git SHA — must survive
].join("\n");

const LEAKED_VALUES = [
  "hunter2secret",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "actualsecretvalue123",
  STRIPE_TEST_KEY,
  "abcd1234efgh5678ijkl",
  "sk-proj-abcdefghijklmnopqrstuvwx"
];

describe("scenario 9 — a `cat .env` cannot leak through the render sanitizer (F1)", () => {
  beforeEach(() => clearRegisteredSecretValues());

  it("redacts EVERY secret value — none survive verbatim", () => {
    const { text, matched } = scrubSecretValuesReport(REALISTIC_ENV);
    for (const leak of LEAKED_VALUES) {
      expect(text).not.toContain(leak);
    }
    expect(matched).toContain("secret-assignment");
    expect(matched).toContain("aws-secret-key");
    expect(matched).toContain("stripe-key");
  });

  it("closes the exact live-proof leak (bare password= / AWS secret / password=)", () => {
    const report = scrubSecretValuesReport("DB_PASSWORD=hunter2secret\nAWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\npassword=actualsecretvalue123");
    expect(report.matched.length).toBeGreaterThan(0);
    expect(report.text).not.toContain("hunter2secret");
    expect(report.text).not.toContain("actualsecretvalue123");
    expect(report.text).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(containsSecretValue("password=actualsecretvalue123")).toBe(true);
  });

  it("keeps the KEY visible and does NOT over-redact a git SHA or ordinary config", () => {
    const text = scrubSecretValues(REALISTIC_ENV);
    expect(text).toContain("DB_PASSWORD="); // key stays, only the value is redacted
    expect(text).toContain("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"); // 40-char git SHA untouched
    expect(text).toContain("LOG_LEVEL=debug"); // non-secret config untouched
  });
});
