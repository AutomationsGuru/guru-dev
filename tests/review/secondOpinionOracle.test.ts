import { describe, expect, it } from "vitest";

import { evaluate } from '../../src/review/secondOpinionOracle.js';

describe("second opinion oracle", () => {
  it("permits shipping only when the second opinion agrees with the claim", () => {
    expect(evaluate({ claim: "The candidate is ready to ship.", oracleResult: "agree" })).toEqual({
      claim: "The candidate is ready to ship.",
      oracleResult: "agree",
      ship: true
    });
  });

  it("blocks shipping when the second opinion disagrees with the claim", () => {
    expect(evaluate({ claim: "The candidate is ready to ship.", oracleResult: "disagree" })).toEqual({
      claim: "The candidate is ready to ship.",
      oracleResult: "disagree",
      ship: false
    });
  });

  it("blocks shipping when the second opinion abstains", () => {
    expect(evaluate({ claim: "The candidate is ready to ship.", oracleResult: "abstain" })).toEqual({
      claim: "The candidate is ready to ship.",
      oracleResult: "abstain",
      ship: false
    });
  });
});
