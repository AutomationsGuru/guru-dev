import { describe, expect, it } from "vitest";

import { evaluateTddEnforceMode } from "../../src/mandates/tddEnforceMode.js";

describe("evaluateTddEnforceMode", () => {
  const lastProductionEditClaim = { recordedAt: "2026-07-19T14:00:00.000Z" };

  it("allows implementation steps when the mode is off", () => {
    expect(
      evaluateTddEnforceMode({
        enabled: false,
        lastProductionEditClaim
      })
    ).toMatchObject({ outcome: "allow" });
  });

  it("denies implementation steps when the mode is on without a failing-test receipt", () => {
    expect(
      evaluateTddEnforceMode({
        enabled: true,
        lastProductionEditClaim
      })
    ).toMatchObject({ outcome: "deny" });
  });

  it("allows implementation steps when the mode is on and a failing-test receipt is newer than the production-edit claim", () => {
    expect(
      evaluateTddEnforceMode({
        enabled: true,
        lastProductionEditClaim,
        failingTestReceipt: { recordedAt: "2026-07-19T14:01:00.000Z" }
      })
    ).toMatchObject({ outcome: "allow" });
  });

  it("denies a stale failing-test receipt", () => {
    expect(
      evaluateTddEnforceMode({
        enabled: true,
        lastProductionEditClaim,
        failingTestReceipt: { recordedAt: "2026-07-19T14:00:00.000Z" }
      })
    ).toMatchObject({ outcome: "deny" });
  });

  it("denies an invalid receipt timestamp instead of treating it as recent", () => {
    expect(
      evaluateTddEnforceMode({
        enabled: true,
        failingTestReceipt: { recordedAt: "not-a-timestamp" }
      })
    ).toMatchObject({ outcome: "deny" });
  });
});
