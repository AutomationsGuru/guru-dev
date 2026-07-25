import { describe, expect, it } from "vitest";

import {
  clusterFailures,
  compareGradeFiles,
  normalizeReason,
  parseGradeFile,
  type GradeFile
} from '../../src/review/evalCompareFailureCluster.js';

function gradeFile(runId: string, cases: Array<{ caseId: string; passed: boolean; score?: number; reason?: string }>): GradeFile {
  return {
    runId,
    cases: cases.map((c) => ({
      caseId: c.caseId,
      passed: c.passed,
      reason: c.reason ?? "",
      ...(c.score === undefined ? {} : { score: c.score })
    }))
  };
}

describe("normalizeReason", () => {
  it("trims and lowercases a reason", () => {
    expect(normalizeReason("  Wrong-Branch ")).toBe("wrong-branch");
  });

  it("collapses empty / non-string reasons to uncategorized", () => {
    expect(normalizeReason("")).toBe("uncategorized");
    expect(normalizeReason("   ")).toBe("uncategorized");
    expect(normalizeReason(undefined)).toBe("uncategorized");
    expect(normalizeReason(42)).toBe("uncategorized");
  });
});

describe("clusterFailures", () => {
  it("groups failing cases by normalized reason and excludes passing cases", () => {
    const file = gradeFile("run-a", [
      { caseId: "c1", passed: false, reason: "Timeout" },
      { caseId: "c2", passed: false, reason: "timeout" },
      { caseId: "c3", passed: false, reason: "wrong-branch" },
      { caseId: "c4", passed: true },
      { caseId: "c5", passed: false } // empty reason → uncategorized
    ]);

    const report = clusterFailures(file);

    expect(report.runId).toBe("run-a");
    expect(report.totalCases).toBe(5);
    expect(report.failed).toBe(4);
    expect(report.passed).toBe(1);
    expect(report.clusters.map((c) => `${c.reason}=${c.count}`)).toEqual([
      "timeout=2",
      "uncategorized=1",
      "wrong-branch=1"
    ]);
    expect(report.clusters[0]?.caseIds).toEqual(["c1", "c2"]);
  });

  it("sorts clusters by count desc then reason asc for determinism", () => {
    const file = gradeFile("run-b", [
      { caseId: "a", passed: false, reason: "zeta" },
      { caseId: "b", passed: false, reason: "zeta" },
      { caseId: "c", passed: false, reason: "alpha" },
      { caseId: "d", passed: false, reason: "alpha" },
      { caseId: "e", passed: false, reason: "mu" }
    ]);

    const report = clusterFailures(file);

    // alpha and zeta tie at 2 → ascending reason → alpha first; mu=1 last.
    expect(report.clusters.map((c) => c.reason)).toEqual(["alpha", "zeta", "mu"]);
  });

  it("reports mean score over [0,1], defaulting pass=1 and fail=0", () => {
    const file = gradeFile("run-c", [
      { caseId: "p1", passed: true, score: 0.8 },
      { caseId: "p2", passed: true }, // default 1
      { caseId: "f1", passed: false } // default 0
    ]);

    expect(clusterFailures(file).meanScore).toBeCloseTo((0.8 + 1 + 0) / 3, 5);
  });

  it("produces an empty cluster set when every case passes", () => {
    const report = clusterFailures(gradeFile("run-d", [{ caseId: "x", passed: true }]));
    expect(report.clusters).toEqual([]);
    expect(report.failed).toBe(0);
  });
});

describe("compareGradeFiles", () => {
  const before = gradeFile("base", [
    { caseId: "stable-pass", passed: true },
    { caseId: "will-regress", passed: true },
    { caseId: "will-improve", passed: false, reason: "timeout" },
    { caseId: "stable-fail", passed: false, reason: "wrong-branch" },
    { caseId: "will-vanish", passed: false, reason: "timeout" }
  ]);

  const after = gradeFile("head", [
    { caseId: "stable-pass", passed: true },
    { caseId: "will-regress", passed: false, reason: "assertion" },
    { caseId: "will-improve", passed: true },
    { caseId: "stable-fail", passed: false, reason: "wrong-branch" },
    { caseId: "brand-new", passed: false, reason: "timeout" }
  ]);

  const report = compareGradeFiles(before, after);

  it("detects a regression (pass → fail)", () => {
    expect(report.regressionDetected).toBe(true);
    expect(report.regressions).toBe(1);
    const regression = report.deltas.find((d) => d.caseId === "will-regress");
    expect(regression?.kind).toBe("regression");
    expect(regression?.reason).toBe("assertion");
  });

  it("counts an added failing case as a regression signal", () => {
    const added = report.deltas.find((d) => d.caseId === "brand-new");
    expect(added?.kind).toBe("added");
    expect(report.regressionDetected).toBe(true);
  });

  it("records improvements (fail → pass)", () => {
    expect(report.improvements).toBe(1);
    const improvement = report.deltas.find((d) => d.caseId === "will-improve");
    expect(improvement?.kind).toBe("improvement");
    expect(improvement?.reason).toBe("timeout");
  });

  it("records removals and not additions as passing-only", () => {
    expect(report.removed).toBe(1); // will-vanish
    expect(report.deltas.find((d) => d.caseId === "will-vanish")?.kind).toBe("removed");
  });

  it("does not flag a regression when nothing passed→failed", () => {
    const clean = compareGradeFiles(
      gradeFile("b", [{ caseId: "x", passed: false, reason: "t" }]),
      gradeFile("a", [{ caseId: "x", passed: true }])
    );
    expect(clean.regressionDetected).toBe(false);
    expect(clean.regressions).toBe(0);
  });

  it("aggregates reason movement (after − before) sorted by worst delta first", () => {
    const byReason = new Map(report.reasonDeltas.map((r) => [r.reason, r]));
    // timeout: before=2, after=1 (brand-new fails) → delta -1
    expect(byReason.get("timeout")).toMatchObject({ before: 2, after: 1, delta: -1 });
    // assertion: before=0, after=1 → delta +1 (the regression)
    expect(byReason.get("assertion")).toMatchObject({ before: 0, after: 1, delta: 1 });
    expect(report.reasonDeltas[0]?.delta).toBeGreaterThanOrEqual(report.reasonDeltas[1]?.delta ?? 0);
  });

  it("produces stable, sorted deltas regardless of input order", () => {
    const shuffled = compareGradeFiles(
      gradeFile("base", [...before.cases].reverse().map((c) => ({ caseId: c.caseId, passed: c.passed, reason: c.reason }))),
      gradeFile("head", [...after.cases].reverse().map((c) => ({ caseId: c.caseId, passed: c.passed, reason: c.reason })))
    );
    expect(shuffled.deltas.map((d) => d.caseId)).toEqual(report.deltas.map((d) => d.caseId));
  });
});

describe("parseGradeFile", () => {
  it("parses a well-formed object, defaulting missing reasons", () => {
    const file = parseGradeFile({ runId: "r1", cases: [{ caseId: "c1", passed: true }] });
    expect(file.runId).toBe("r1");
    expect(file.cases[0]?.reason).toBe("uncategorized");
  });

  it("clamps out-of-range scores into [0,1]", () => {
    const file = parseGradeFile({ runId: "r2", cases: [{ caseId: "c1", passed: true, score: 5 }] });
    expect(file.cases[0]?.score).toBe(1);
  });

  it("throws on a missing runId", () => {
    expect(() => parseGradeFile({ cases: [] })).toThrow(/runId/);
  });

  it("throws on a non-boolean passed", () => {
    expect(() => parseGradeFile({ runId: "r", cases: [{ caseId: "c", passed: "yes" }] })).toThrow(/passed/);
  });

  it("throws on a non-array cases field", () => {
    expect(() => parseGradeFile({ runId: "r", cases: {} })).toThrow(/cases/);
  });
});
