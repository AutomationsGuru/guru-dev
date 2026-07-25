import { grade, type RubricCriterion } from '../../src/review/rubricGraderSlot.js';

describe("grade", () => {
  it("returns the weighted average for criterion scores", () => {
    const criteria: readonly RubricCriterion[] = [
      { id: "correctness", weight: 3 },
      { id: "evidence", weight: 1 }
    ];

    expect(grade(criteria, { correctness: 1, evidence: 0 })).toBe(0.75);
  });

  it("treats missing scores as zero while retaining their criterion weight", () => {
    const criteria: readonly RubricCriterion[] = [
      { id: "correctness", weight: 1 },
      { id: "evidence", weight: 3 }
    ];

    expect(grade(criteria, { correctness: 1 })).toBe(0.25);
  });

  it("keeps the result within the 0-1 range", () => {
    const criteria: readonly RubricCriterion[] = [
      { id: "quality", weight: 1 },
      { id: "invalid", weight: -1 }
    ];

    expect(grade(criteria, { quality: 2, invalid: 1 })).toBe(1);
    expect(grade(criteria, { quality: Number.NaN, invalid: 1 })).toBe(0);
  });

  it("returns zero when no positive finite criterion weight exists", () => {
    expect(grade([{ id: "quality", weight: 0 }], { quality: 1 })).toBe(0);
  });
});
