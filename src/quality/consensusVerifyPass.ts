/**
 * Consensus verify pass (F307) — P1 daily-driver quality gate.
 *
 * Aggregates caller-supplied immutable score records into a pass/fail verdict.
 * This module NEVER calls agents/models, fans out, spends, selects providers,
 * weakens independent review, or converts consensus into merge/release authority.
 *
 * Unknown/missing scores fail closed. Every threshold and result is inspectable.
 *
 * Composes: F86 oracle · F210 grader (score production, not aggregation).
 */

// ── Types ──────────────────────────────────────────────────────────

/** An immutable score record produced by an upstream oracle or grader. */
export interface ConsensusScoreRecord {
  readonly agentId: string;
  /** Normalized score in [0, 1]. Values outside this range are filtered. */
  readonly score: number;
  /** Optional human-readable rationale for the score. */
  readonly rationale?: string;
}

/** The inspectable consensus verdict — every input and output is visible. */
export interface ConsensusVerdict {
  /** True when the aggregated average meets or exceeds the threshold. */
  readonly passed: boolean;
  /** The claim that was evaluated. */
  readonly claim: string;
  /** The threshold that was applied. */
  readonly threshold: number;
  /** Count of valid scores after filtering (NaN/Infinity/out-of-range excluded). */
  readonly scoreCount: number;
  /** Number of scores ≥ threshold. */
  readonly agreeingCount: number;
  /** Arithmetic mean of the valid scores, or 0 when none. */
  readonly avgScore: number;
  /** All caller-supplied score records (including any filtered-out invalid ones). */
  readonly scores: readonly ConsensusScoreRecord[];
  /** Human-readable summary: PASS/FAIL, avg, threshold, count. */
  readonly summary: string;
}

// ── Implementation ─────────────────────────────────────────────────

/**
 * Verify a claim via caller-supplied consensus scores.
 *
 * Aggregates immutable score records: filters invalid values (NaN, Infinity, out-of-range),
 * calculates the average of the remainder, and passes when avg ≥ threshold.
 *
 * Fail-closed: zero valid scores → `passed: false`. The threshold must be in [0, 1] and finite.
 *
 * This is a PURE AGGREGATION function. It does not call models, agents, providers, or tools.
 * Score production belongs to F86 oracle and F210 grader.
 */
export function verifyConsensus(
  claim: string,
  scores: readonly ConsensusScoreRecord[],
  threshold: number
): ConsensusVerdict {
  // Validate threshold first — structural enforce, not prose
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new Error(
      `consensusVerifyPass: threshold must be a finite number in [0, 1], got ${threshold}`
    );
  }

  // Filter valid scores (finite, in [0, 1])
  const validScores = scores.filter(
    (s) =>
      typeof s.score === "number" &&
      Number.isFinite(s.score) &&
      s.score >= 0 &&
      s.score <= 1
  );

  const scoreCount = validScores.length;

  // Fail closed: no valid scores → cannot pass
  if (scoreCount === 0) {
    return {
      passed: false,
      claim,
      threshold,
      scoreCount: 0,
      agreeingCount: 0,
      avgScore: 0,
      scores: [...scores], // preserve the original input for inspectability
      summary: `consensus FAIL — no valid scores (${scores.length} supplied${
        scores.length > 0 ? ", all filtered" : ""
      }) against threshold ${threshold}, claim: "${claim}"`
    };
  }

  const total = validScores.reduce((sum, s) => sum + s.score, 0);
  const avgScore = total / scoreCount;
  const agreeingCount = validScores.filter((s) => s.score >= threshold).length;
  const passed = avgScore >= threshold;

  const summary = `consensus ${passed ? "PASS" : "FAIL"} — ${scoreCount} agent(s), avg ${avgScore.toFixed(4)} ${
    passed ? "≥" : "<"
  } threshold ${threshold}, ${agreeingCount}/${scoreCount} agreeing, claim: "${claim}"`;

  return {
    passed,
    claim,
    threshold,
    scoreCount,
    agreeingCount,
    avgScore,
    scores: [...scores], // preserve the original input for inspectability
    summary
  };
}
