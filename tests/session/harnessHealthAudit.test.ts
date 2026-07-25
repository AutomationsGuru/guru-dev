import { describe, expect, it } from "vitest";

import { scoreHarnessHealth, type HarnessHealthSnapshot } from '../../src/session/harnessHealthAudit.js';

const healthySnapshot: HarnessHealthSnapshot = {
  authReady: true,
  toolsReady: true,
  skillsReady: true,
  hardLimitConfigReady: true,
  weights: {
    auth: 40,
    tools: 25,
    skills: 15,
    hardLimitConfig: 20
  }
};

describe("scoreHarnessHealth", () => {
  it("returns a perfect score with no gaps when every readiness check passes", () => {
    expect(scoreHarnessHealth(healthySnapshot)).toEqual({ score: 100, gaps: [] });
  });

  it("lowers the score and reports the auth gap when authentication is unavailable", () => {
    expect(scoreHarnessHealth({ ...healthySnapshot, authReady: false })).toEqual({
      score: 60,
      gaps: ["auth"]
    });
  });

  it("is deterministic and ignores invalid weights instead of producing an invalid score", () => {
    const snapshot: HarnessHealthSnapshot = {
      ...healthySnapshot,
      toolsReady: false,
      weights: { auth: 10, tools: Number.NaN, skills: -1, hardLimitConfig: 10 }
    };

    expect(scoreHarnessHealth(snapshot)).toEqual({ score: 100, gaps: ["tools"] });
    expect(scoreHarnessHealth(snapshot)).toEqual(scoreHarnessHealth(snapshot));
  });
});
