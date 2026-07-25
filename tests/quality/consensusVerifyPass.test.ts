import { describe, expect, it } from "vitest";

import {
  verifyConsensus,
  type ConsensusScoreRecord,
  type ConsensusVerdict
} from '../../src/quality/consensusVerifyPass.js';

// Helper: valid score record
function score(
  agentId: string,
  score: number,
  rationale?: string
): ConsensusScoreRecord {
  return { agentId, score, ...(rationale !== undefined ? { rationale } : {}) };
}

// Helper: produce a minimal verdict snapshot for assertions (drops the scores array for legibility)
function verdictSnapshot(v: ConsensusVerdict) {
  return {
    passed: v.passed,
    claim: v.claim,
    threshold: v.threshold,
    scoreCount: v.scoreCount,
    avgScore: v.avgScore,
    agreeingCount: v.agreeingCount,
    summary: v.summary
  };
}

describe("verifyConsensus — consensus verify pass (F307)", () => {
  const claim = "The sky is blue.";

  // ── 1. Threshold pass/fail ──

  it("passes when average of all valid scores exceeds threshold", () => {
    const scores = [score("a", 0.8, "looks correct"), score("b", 0.9, "confirmed")];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(true);
    expect(result.avgScore).toBeCloseTo(0.85);
    expect(result.scoreCount).toBe(2);
    expect(result.agreeingCount).toBe(2); // both >= 0.7
  });

  it("fails when average of all valid scores is below threshold", () => {
    const scores = [score("a", 0.5), score("b", 0.4)];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(false);
    expect(result.avgScore).toBeCloseTo(0.45);
    expect(result.scoreCount).toBe(2);
    expect(result.agreeingCount).toBe(0);
  });

  it("passes when average exactly equals threshold", () => {
    const scores = [score("a", 0.7), score("b", 0.7)];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(true);
    expect(result.avgScore).toBeCloseTo(0.7);
  });

  it("passes with a mix of agreeing and disagreeing — average decides", () => {
    const scores = [score("a", 1.0), score("b", 0.4), score("c", 0.4)];
    const result = verifyConsensus(claim, scores, 0.6);
    expect(result.passed).toBe(true); // avg = 0.6 ≥ 0.6
    expect(result.agreeingCount).toBe(1); // only a >= 0.6
  });

  // ── 2. Single agent mode ──

  it("single agent passes when its score meets the threshold", () => {
    const result = verifyConsensus(claim, [score("sole", 0.8)], 0.6);
    expect(result.passed).toBe(true);
    expect(result.avgScore).toBe(0.8);
    expect(result.scoreCount).toBe(1);
    expect(result.agreeingCount).toBe(1);
  });

  it("single agent fails when its score is below the threshold", () => {
    const result = verifyConsensus(claim, [score("sole", 0.3)], 0.6);
    expect(result.passed).toBe(false);
    expect(result.agreeingCount).toBe(0);
  });

  // ── 3. Empty / missing scores fail closed ──

  it("fails closed with empty scores array", () => {
    const result = verifyConsensus(claim, [], 0.7);
    expect(result.passed).toBe(false);
    expect(result.scoreCount).toBe(0);
    expect(result.avgScore).toBe(0);
    expect(result.agreeingCount).toBe(0);
    expect(result.summary).toContain("no valid scores");
  });

  it("fails closed when all scores are invalid (NaN, Infinity)", () => {
    const scores = [
      { agentId: "a", score: NaN },
      { agentId: "b", score: Infinity },
      { agentId: "c", score: -Infinity }
    ] as unknown as ConsensusScoreRecord[];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(false);
    expect(result.scoreCount).toBe(0);
    expect(result.summary).toContain("no valid scores");
  });

  it("succeeds after filtering invalid scores and keeping valid ones", () => {
    const scores = [
      { agentId: "a", score: NaN },
      score("b", 0.9),
      { agentId: "c", score: Infinity }
    ] as unknown as ConsensusScoreRecord[];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(true);
    expect(result.scoreCount).toBe(1); // only b
    expect(result.avgScore).toBe(0.9);
  });

  // ── 4. Out-of-range scores ──

  it("filters out scores below 0", () => {
    const scores = [score("a", -0.1), score("b", 0.9)];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(true);
    expect(result.scoreCount).toBe(1);
  });

  it("filters out scores above 1", () => {
    const scores = [score("a", 1.5), score("b", 0.4)];
    const result = verifyConsensus(claim, scores, 0.7);
    expect(result.passed).toBe(false);
    expect(result.scoreCount).toBe(1);
  });

  // ── 5. Invalid threshold ──

  it("throws when threshold is negative", () => {
    expect(() => verifyConsensus(claim, [score("a", 0.5)], -0.1)).toThrow(
      "threshold"
    );
  });

  it("throws when threshold exceeds 1", () => {
    expect(() => verifyConsensus(claim, [score("a", 0.5)], 1.5)).toThrow(
      "threshold"
    );
  });

  it("throws when threshold is NaN", () => {
    expect(() => verifyConsensus(claim, [score("a", 0.5)], NaN)).toThrow(
      "threshold"
    );
  });

  it("accepts threshold 0 (any non-negative average passes)", () => {
    const result = verifyConsensus(claim, [score("a", 0.0)], 0.0);
    expect(result.passed).toBe(true);
  });

  it("accepts threshold 1 (only perfect scores pass)", () => {
    const high = verifyConsensus(claim, [score("a", 1.0), score("b", 1.0)], 1.0);
    expect(high.passed).toBe(true);

    const mixed = verifyConsensus(claim, [score("a", 1.0), score("b", 0.9)], 1.0);
    expect(mixed.passed).toBe(false);
  });

  // ── 6. Inspectability ──

  it("returns all individual scores in the verdict for inspectability", () => {
    const scores = [score("a", 0.8), score("b", 0.3)];
    const result = verifyConsensus(claim, scores, 0.6);
    expect(result.scores).toEqual(scores);
  });

  it("the claim is preserved in the verdict", () => {
    const result = verifyConsensus(claim, [score("a", 0.9)], 0.5);
    expect(result.claim).toBe(claim);
  });

  it("the summary is human-readable and includes key numbers", () => {
    const result = verifyConsensus(claim, [score("a", 0.8), score("b", 0.6)], 0.5);
    expect(result.summary).toContain("2");
    expect(result.summary).toContain("0.5"); // threshold
    expect(result.summary).toContain("PASS"); // passed
  });

  it("a failing summary includes the avg vs threshold", () => {
    const result = verifyConsensus(claim, [score("a", 0.1)], 0.8);
    expect(result.summary).toContain("FAIL");
    expect(result.summary).toContain("0.1");
    expect(result.summary).toContain("0.8");
  });

  // ── 7. Scores are treated as immutable caller-supplied records ──

  it("does not mutate the input scores array", () => {
    const scores = [score("a", 0.5), score("b", 0.7)];
    const frozen = Object.freeze([...scores]);
    const result = verifyConsensus(claim, frozen, 0.6);
    expect(result.scores).toEqual(scores);
  });

  // ── 8. Large N-agent consensus ──

  it("correctly aggregates a large number of agents", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      score(`agent-${i}`, i < 60 ? 0.8 : 0.2)
    );
    const result = verifyConsensus(claim, many, 0.5);
    // 60 * 0.8 + 40 * 0.2 = 48 + 8 = 56 / 100 = 0.56 ≥ 0.5 → pass
    expect(result.passed).toBe(true);
    expect(result.scoreCount).toBe(100);
    expect(result.agreeingCount).toBe(60);
    expect(result.avgScore).toBeCloseTo(0.56, 5);
  });

  // ── 9. Type safety: ConsensusVerdict is read-only by construction ──

  it("the result type carries readonly scores", () => {
    const result = verifyConsensus(claim, [score("a", 0.5)], 0.5);
    // This compiles: readonly array type
    const scores: readonly ConsensusScoreRecord[] = result.scores;
    expect(scores).toHaveLength(1);
  });
});
