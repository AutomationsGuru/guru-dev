import { describe, expect, it } from "vitest";

import { applyAdvisor } from "../../src/review/turnAdvisorChannel.js";

describe("turn advisor channel", () => {
  it("recommends stopping for a blocker without taking stop authority", () => {
    expect(applyAdvisor({ severity: "blocker", text: "  Preserve the current overlay before continuing.  " })).toEqual({
      severity: "blocker",
      text: "Preserve the current overlay before continuing.",
      stopRecommended: true
    });
  });

  it("keeps a concern advisory and does not recommend stopping", () => {
    expect(applyAdvisor({ severity: "concern", text: "Run the focused test before handoff." })).toEqual({
      severity: "concern",
      text: "Run the focused test before handoff.",
      stopRecommended: false
    });
  });
});
