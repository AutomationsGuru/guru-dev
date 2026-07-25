import { describe, expect, it } from "vitest";

import { mayClaimDone } from '../../src/session/evidenceOverClaims.js';

describe("mayClaimDone", () => {
  it("blocks a done claim without evidence or a skip reason", () => {
    expect(mayClaimDone({ evidenceIds: [] })).toBe(false);
  });

  it("allows a done claim with evidence", () => {
    expect(mayClaimDone({ evidenceIds: ["test-123"] })).toBe(true);
  });

  it("allows a done claim with an explicit skip reason", () => {
    expect(mayClaimDone({ evidenceIds: [], skipReason: "Validation is unavailable." })).toBe(true);
  });
});
