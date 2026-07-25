import { describe, expect, it } from "vitest";

import {
  grade,
  type EvalMetric,
  type EvalTrace,
  type GradeDeps,
  type MetricOutcome
} from '../../src/review/agentEvalGenerateGrade.js';

/** A trace that passes every metric (long enough and contains the keyword). */
const passTrace = (id: string): EvalTrace => ({ caseId: id, output: "ok-done", ...(id.endsWith("x") ? { notes: "x" } : {}) });

/** A trace that FAILS the `length` metric (output too short) but passes `keyword`. */
const shortTrace = (id: string): EvalTrace => ({ caseId: id, output: "ok" });

const lengthMetric: EvalMetric = {
  id: "length",
  description: "output length >= 4",
  evaluate: (t) => (t.output.length >= 4 ? { pass: true } : { pass: false, reason: "too short" })
};

const keywordMetric: EvalMetric = {
  id: "keyword",
  description: "output contains 'ok'",
  evaluate: (t) => (t.output.includes("ok") ? { pass: true } : { pass: false, reason: "missing keyword" })
};

describe("agentEvalGenerateGrade — pure grading pipeline (R-GAC-EVAL)", () => {
  it("all-pass traces → score 1.0 for every metric; scores map keyed by metric id", () => {
    const traces = [passTrace("c1"), passTrace("c2"), passTrace("c3")];
    const report = grade(traces, [lengthMetric, keywordMetric], {});

    expect(report.scores).toBeInstanceOf(Map);
    expect(report.scores.get("length")?.score).toBe(1);
    expect(report.scores.get("keyword")?.score).toBe(1);
    expect(report.scores.get("length")?.passed).toBe(3);
    expect(report.scores.get("length")?.total).toBe(3);
  });

  it("a FAILING metric lowers the score below all-pass (the core regression contract)", () => {
    // 3 traces: 2 pass length, 1 fails length; all pass keyword.
    const traces = [passTrace("c1"), passTrace("c2"), shortTrace("c3")];
    const report = grade(traces, [lengthMetric, keywordMetric], {});

    const lengthScore = report.scores.get("length")?.score;
    const keywordScore = report.scores.get("keyword")?.score;

    expect(lengthScore).toBe(2 / 3); // lowered — one trace failed
    expect(keywordScore).toBe(1); // unaffected
    expect(lengthScore!).toBeLessThan(keywordScore!); // fail metric lowers score vs the passing metric
    expect(report.scores.get("length")?.passed).toBe(2);
    expect(report.scores.get("length")?.total).toBe(3);
  });

  it("records the failure reason per failing trace (evidence, not just a count)", () => {
    const traces = [shortTrace("c1"), passTrace("c2")];
    const report = grade(traces, [lengthMetric], {});

    const length = report.scores.get("length");
    expect(length?.failures).toHaveLength(1);
    expect(length?.failures[0]?.caseId).toBe("c1");
    expect(length?.failures[0]?.reason).toBe("too short");
  });

  it("grades against a metric list with NO metric evaluator → default: every metric is ungraded (honest 0 scored, not silent pass)", () => {
    // A metric without an `evaluate` fn cannot be graded; report it as 0 with no traces scored,
    // never silently as a perfect score.
    const metricWithoutEval: EvalMetric = { id: "bare", description: "no predicate" };
    const report = grade([passTrace("c1")], [metricWithoutEval], {});

    const bare = report.scores.get("bare");
    expect(bare?.score).toBe(0);
    expect(bare?.total).toBe(0); // not graded
    expect(bare?.ungraded).toBe(true);
  });

  it("an injected pure evaluator OVERRIDES the metric's own predicate (model-agnostic seam)", () => {
    // The grading core never calls a model; it delegates evaluation to a pure fn. Injecting a
    // different evaluator changes the grades without touching the core (the BUILD/ATTACH seam).
    const alwaysFail: GradeDeps["evaluate"] = (_metric, _trace): MetricOutcome => ({
      pass: false,
      reason: "injected override"
    });
    const report = grade([passTrace("c1"), passTrace("c2")], [keywordMetric], { evaluate: alwaysFail });

    expect(report.scores.get("keyword")?.score).toBe(0);
    expect(report.scores.get("keyword")?.passed).toBe(0);
  });

  it("is PURE: same inputs → same output, no mutation of inputs, no side effects (no throws)", () => {
    const traces = [passTrace("c1"), shortTrace("c2")];
    const snapshot = JSON.stringify(traces);

    const a = grade(traces, [lengthMetric, keywordMetric], {});
    const b = grade(traces, [lengthMetric, keywordMetric], {});

    expect(JSON.stringify(a)).toEqual(JSON.stringify(b)); // deterministic
    expect(JSON.stringify(traces)).toEqual(snapshot); // inputs untouched
  });

  it("empty trace set → every metric scores 0 with total 0 (honest, not a fake 1.0)", () => {
    const report = grade([], [lengthMetric], {});
    expect(report.scores.get("length")?.score).toBe(0);
    expect(report.scores.get("length")?.total).toBe(0);
  });

  it("a metric that throws during evaluation is recorded as a failure for that trace, not a crash", () => {
    const throwingMetric: EvalMetric = {
      id: "boom",
      description: "throws",
      evaluate: () => {
        throw new Error("explode");
      }
    };
    const report = grade([passTrace("c1")], [throwingMetric], {});
    const boom = report.scores.get("boom");
    expect(boom?.score).toBe(0);
    expect(boom?.failures[0]?.reason).toContain("explode");
  });

  it("reports an overall score = mean of graded metric scores, and a pass/fail summary", () => {
    const traces = [passTrace("c1"), shortTrace("c2")]; // length 1/2, keyword 2/2
    const report = grade(traces, [lengthMetric, keywordMetric], {});
    expect(report.overall).toBeCloseTo((0.5 + 1) / 2, 10);
    expect(report.metricsPassed).toBe(1); // only keyword reached 1.0
    expect(report.metricsTotal).toBe(2);
  });
});
