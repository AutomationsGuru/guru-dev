import { describe, expect, it } from "vitest";

import { evaluate } from '../../src/review/craftQualityChecklist.js';

describe("craft quality checklist", () => {
  it("allows a ship claim when every named criterion passes", () => {
    expect(evaluate({ tests: true, typecheck: true, review: true })).toBe(true);
  });

  it("blocks a ship claim when any named criterion fails", () => {
    expect(evaluate({ tests: true, typecheck: false, review: true })).toBe(false);
  });
});
