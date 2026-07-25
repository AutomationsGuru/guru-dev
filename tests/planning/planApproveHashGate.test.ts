import {
  canExecute,
  computePlanHash,
  createPlanApproveReceipt,
  PlanApproveReceiptSchema
} from '../../src/planning/planApproveHashGate.js';
import type { PlanApproveReceipt } from '../../src/planning/planApproveHashGate.js';

const samplePlanJson = JSON.stringify({
  objective: "Read the README.",
  summary: "One step plan.",
  steps: [{ id: "one", title: "One", toolId: "repo.context.resolve", input: {} }]
});

const otherPlanJson = JSON.stringify({
  objective: "Different objective.",
  summary: "Different plan.",
  steps: []
});

describe("computePlanHash", () => {
  it("returns a 64-character lowercase hex digest", () => {
    const hash = computePlanHash(samplePlanJson);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable: the same input produces the same digest", () => {
    expect(computePlanHash(samplePlanJson)).toBe(computePlanHash(samplePlanJson));
  });

  it("differs for different plan content", () => {
    expect(computePlanHash(samplePlanJson)).not.toBe(computePlanHash(otherPlanJson));
  });
});

describe("canExecute", () => {
  it("returns true when planHash matches the receipt planHash", () => {
    const planHash = computePlanHash(samplePlanJson);
    const receipt = createPlanApproveReceipt(planHash, "human:matthew");

    expect(canExecute(planHash, receipt)).toBe(true);
  });

  it("returns false on a mismatching planHash (headline requirement)", () => {
    const approvedHash = computePlanHash(samplePlanJson);
    const receipt = createPlanApproveReceipt(approvedHash, "human:matthew");
    const executedHash = computePlanHash(otherPlanJson);

    expect(canExecute(executedHash, receipt)).toBe(false);
  });

  it("returns false when planHash is malformed even if the receipt is valid", () => {
    const receipt = createPlanApproveReceipt(computePlanHash(samplePlanJson), "human:matthew");

    expect(canExecute("not-a-real-digest", receipt)).toBe(false);
  });

  it("does not throw and returns false when the receipt planHash is missing", () => {
    const planHash = computePlanHash(samplePlanJson);
    const malformed = { planHash: undefined, approvedAt: new Date().toISOString(), approver: "x" } as unknown as PlanApproveReceipt;

    expect(canExecute(planHash, malformed)).toBe(false);
  });

  it("does not throw and returns false when the receipt planHash has the wrong length", () => {
    const planHash = computePlanHash(samplePlanJson);
    const malformed = { planHash: "abcd", approvedAt: new Date().toISOString(), approver: "x" } as unknown as PlanApproveReceipt;

    expect(canExecute(planHash, malformed)).toBe(false);
  });
});

describe("PlanApproveReceiptSchema", () => {
  it("rejects a receipt whose planHash is not a valid digest", () => {
    const result = PlanApproveReceiptSchema.safeParse({
      planHash: "nope",
      approvedAt: new Date().toISOString(),
      approver: "human:matthew"
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown keys because the schema is strict", () => {
    const result = PlanApproveReceiptSchema.safeParse({
      planHash: computePlanHash(samplePlanJson),
      approvedAt: new Date().toISOString(),
      approver: "human:matthew",
      extra: "nope"
    });

    expect(result.success).toBe(false);
  });

  it("accepts a well-formed receipt", () => {
    const result = PlanApproveReceiptSchema.safeParse({
      planHash: computePlanHash(samplePlanJson),
      approvedAt: new Date().toISOString(),
      approver: "human:matthew"
    });

    expect(result.success).toBe(true);
  });
});
