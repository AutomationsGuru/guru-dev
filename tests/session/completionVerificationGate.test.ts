import { describe, expect, it } from "vitest";

import { canClaimComplete } from '../../src/session/completionVerificationGate.js';

describe("completionVerificationGate — canClaimComplete", () => {
  it("bare claim (no verification, no skip) returns false", () => {
    expect(canClaimComplete({})).toBe(false);
  });

  it("skip with a non-empty reason returns true", () => {
    expect(canClaimComplete({ skipReason: "sanity-checked manually" })).toBe(true);
  });

  it("skip with a multi-word reason returns true", () => {
    expect(canClaimComplete({ skipReason: "no test infra for this surface yet" })).toBe(true);
  });

  it("skip with whitespace-only reason returns false (reject empty skip)", () => {
    expect(canClaimComplete({ skipReason: "   " })).toBe(false);
  });

  it("skip with empty string returns false (reject empty skip)", () => {
    expect(canClaimComplete({ skipReason: "" })).toBe(false);
  });

  it("verification with exitCode 0 returns true", () => {
    expect(
      canClaimComplete({ verification: { exitCode: 0 } })
    ).toBe(true);
  });

  it("verification with exitCode 0 and captured output returns true", () => {
    expect(
      canClaimComplete({
        verification: { exitCode: 0, output: "23 passed, 0 failed" }
      })
    ).toBe(true);
  });

  it("verification with non-zero exitCode returns false", () => {
    expect(
      canClaimComplete({ verification: { exitCode: 1 } })
    ).toBe(false);
  });

  it("verification with exitCode 2 returns false", () => {
    expect(
      canClaimComplete({ verification: { exitCode: 2 } })
    ).toBe(false);
  });

  it("verification takes precedence over skipReason — fail exits reject even with a reason", () => {
    expect(
      canClaimComplete({
        verification: { exitCode: 1 },
        skipReason: "ran tests but they failed"
      })
    ).toBe(false);
  });

  it("verification takes precedence over skipReason — passing verification with a reason returns true", () => {
    expect(
      canClaimComplete({
        verification: { exitCode: 0, output: "all green" },
        skipReason: "backup reason"
      })
    ).toBe(true);
  });
});
