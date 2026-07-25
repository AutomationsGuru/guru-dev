import { describe, it, expect } from "vitest";

import { scoreHarnessHealth, type HarnessHealthSnapshot } from '../../src/readiness/harnessHealthScore.js';

describe("scoreHarnessHealth", () => {
  it("returns identical score and gaps for identical snapshot input (deterministic pure function)", () => {
    const snapshot: HarnessHealthSnapshot = {
      componentCount: 8,
      readyCount: 6,
      failingComponents: ["provider:deepseek"],
      missingEnv: ["API_KEY"]
    };

    const result1 = scoreHarnessHealth(snapshot);
    const result2 = scoreHarnessHealth(snapshot);

    expect(result1).toEqual(result2);
    expect(result1.score).toBeGreaterThanOrEqual(0);
    expect(result1.score).toBeLessThanOrEqual(100);
  });

  it("returns score 100 with empty gaps when snapshot has no issues (full readiness, zero failing, zero missing)", () => {
    const perfectSnapshot: HarnessHealthSnapshot = {
      componentCount: 5,
      readyCount: 5,
      failingComponents: [],
      missingEnv: []
    };

    const result = scoreHarnessHealth(perfectSnapshot);

    expect(result.score).toBe(100);
    expect(result.gaps).toEqual([]);
  });
});
