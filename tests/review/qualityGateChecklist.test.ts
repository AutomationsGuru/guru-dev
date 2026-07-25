import { describe, expect, it } from "vitest";

import { evaluate, QualityGateCheckSchema, QualityGateChecklistSchema, type QualityGateCheck } from '../../src/review/qualityGateChecklist.js';

// ── Schema-level validation ──────────────────────────────────────────────────

describe("QualityGateCheckSchema", () => {
  it("accepts a valid check with all fields", () => {
    const result = QualityGateCheckSchema.safeParse({
      name: "lint",
      status: "pass",
      reason: "no issues"
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid check without an optional reason", () => {
    const result = QualityGateCheckSchema.safeParse({ name: "lint", status: "fail" });
    expect(result.success).toBe(true);
  });

  it("rejects a check with an empty name", () => {
    const result = QualityGateCheckSchema.safeParse({ name: "", status: "pass" });
    expect(result.success).toBe(false);
  });

  it("rejects a check with an invalid status", () => {
    const result = QualityGateCheckSchema.safeParse({ name: "lint", status: "maybe" });
    expect(result.success).toBe(false);
  });

  it("rejects a check missing name", () => {
    const result = QualityGateCheckSchema.safeParse({ status: "pass" });
    expect(result.success).toBe(false);
  });

  it("rejects a check missing status", () => {
    const result = QualityGateCheckSchema.safeParse({ name: "lint" });
    expect(result.success).toBe(false);
  });
});

describe("QualityGateChecklistSchema", () => {
  it("accepts a checklist with at least one check", () => {
    const result = QualityGateChecklistSchema.safeParse({
      checks: [{ name: "lint", status: "pass" }]
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty checks array", () => {
    const result = QualityGateChecklistSchema.safeParse({ checks: [] });
    expect(result.success).toBe(false);
  });

  it("rejects when checks is missing", () => {
    const result = QualityGateChecklistSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── evaluate() behaviour ─────────────────────────────────────────────────────

describe("evaluate", () => {
  // ── Proceed (GREEN) ──────────────────────────────────────────────────────

  it("allows proceed when every check passes", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "pass" },
      { name: "typecheck", status: "pass" },
      { name: "test", status: "pass" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(true);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(3);
    expect(result.summary).toMatch(/All 3 check\(s\) clear/);
  });

  it("allows proceed when checks are all pass or skip — no fails", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "pass" },
      { name: "coverage", status: "skip", reason: "threshold not configured" },
      { name: "test", status: "pass" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(true);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("allows proceed when every check is skipped", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "skip" },
      { name: "coverage", status: "skip" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(true);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it("allows proceed with a single passing check", () => {
    const checks: QualityGateCheck[] = [{ name: "lint", status: "pass" }];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(true);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(1);
  });

  // ── Block (RED) ──────────────────────────────────────────────────────────

  it("blocks proceed when a single check fails", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "pass" },
      { name: "typecheck", status: "fail", reason: "TS2322" },
      { name: "test", status: "pass" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(false);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(3);
    expect(result.summary).toMatch(/1 of 3 check\(s\) failed/);
  });

  it("blocks proceed when every check fails", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "fail" },
      { name: "typecheck", status: "fail" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.summary).toMatch(/2 of 2 check\(s\) failed/);
  });

  it("blocks proceed when one check fails among skips", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "skip" },
      { name: "typecheck", status: "fail" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("throws for an empty checks array (SchemaError)", () => {
    expect(() => evaluate([])).toThrow();
  });

  it("throws when a check has an unknown status (SchemaError)", () => {
    const checks = [{ name: "lint", status: "unknown" }];
    // @ts-expect-error — deliberately invalid for the runtime test
    expect(() => evaluate(checks)).toThrow();
  });

  it("throws when a check name is empty (SchemaError)", () => {
    const checks = [{ name: "", status: "pass" }];
    // @ts-expect-error — deliberately invalid for the runtime test
    expect(() => evaluate(checks)).toThrow();
  });

  it("is deterministic — same input → same output", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "pass" },
      { name: "test", status: "fail" }
    ];
    const a = evaluate(checks);
    const b = evaluate(checks);

    expect(a).toEqual(b);
  });

  it("counts correctly with duplicate check names", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "pass" },
      { name: "lint", status: "fail" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(false);
    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("produces a blocked summary for a mixed outcome with fails", () => {
    const checks: QualityGateCheck[] = [
      { name: "lint", status: "pass" },
      { name: "typecheck", status: "fail" },
      { name: "test", status: "skip" }
    ];
    const result = evaluate(checks);

    expect(result.mayProceed).toBe(false);
    expect(result.summary).toMatch(/1 of 3 check\(s\) failed/);
    expect(result.summary).toMatch(/blocked/);
  });
});
