import { describe, expect, it } from "vitest";

import {
  buildLongHorizonDefaults,
  DEFAULT_COMPLETION_GATE_IDS,
  HARD_LIMIT_GATE_IDS,
  LongHorizonDefaultsSchema,
  type LongHorizonDefaults
} from "../../src/runtime/longHorizonDefaults.js";

describe("longHorizonDefaults", () => {
  it("exposes a frozen array of package-default completion gate ids", () => {
    expect(DEFAULT_COMPLETION_GATE_IDS.length).toBeGreaterThan(0);
    for (const id of HARD_LIMIT_GATE_IDS) {
      expect(DEFAULT_COMPLETION_GATE_IDS).toContain(id);
    }

    const subject = DEFAULT_COMPLETION_GATE_IDS as unknown as string[];
    const lengthBefore = subject.length;
    Object.freeze(subject);
    const pushOnce = () => {
      subject.push("rogue");
    };

    expect(() => {
      pushOnce();
    }).toThrow();

    expect(subject.length).toBe(lengthBefore);
    expect(subject).not.toContain("rogue");
  });

  it("returns a frozen, schema-valid defaults package", () => {
    const defaults = buildLongHorizonDefaults();

    const reparsed = LongHorizonDefaultsSchema.safeParse(defaults);
    expect(reparsed.success).toBe(true);

    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.gates)).toBe(true);
    expect(Object.isFrozen(defaults.goal)).toBe(true);
    expect(Object.isFrozen(defaults.rubric)).toBe(true);
    expect(Object.isFrozen(defaults.plan)).toBe(true);
    expect(Object.isFrozen(defaults.budget)).toBe(true);
  });

  it("includes every hard-limit completion gate id in the default gate list", () => {
    const defaults = buildLongHorizonDefaults();

    for (const id of HARD_LIMIT_GATE_IDS) {
      expect(defaults.gates.completionGateIds).toContain(id);
    }
  });

  it("uses fail-closed approval defaults and forbids auto-commit/push/pr", () => {
    const defaults = buildLongHorizonDefaults();

    expect(defaults.gates.approvalPolicy.autoCommitPushPr).toBe(false);
    expect(defaults.gates.approvalPolicy.allowLocalMerge).toBe(false);
    expect(defaults.gates.approvalPolicy.allowForcePush).toBe(false);
    expect(defaults.gates.reviewGate.required).toBe(true);
    expect(defaults.gates.reviewGate.provider).toBe("native-critic-panel");
  });

  it("returns an empty starter goal (no implicit acceptance criteria)", () => {
    const defaults = buildLongHorizonDefaults();

    expect(defaults.goal.acceptanceCriteria).toEqual([]);
    expect(defaults.goal.status).toBe("active");
    expect(defaults.goal.sticky).toBe(false);
  });

  it("returns an empty starter rubric (no pre-baked grading behavior)", () => {
    const defaults = buildLongHorizonDefaults();

    expect(defaults.rubric.criteria).toEqual([]);
    expect(defaults.rubric.sticky).toBe(false);
  });

  it("exposes a bounded plan and budget suitable for long multi-step sessions", () => {
    const defaults = buildLongHorizonDefaults();

    expect(defaults.budget.maxTurns).toBeGreaterThan(0);
    expect(defaults.budget.maxWallClockMs).toBeGreaterThan(0);
    expect(defaults.budget.maxToolCalls).toBeGreaterThan(0);
    expect(defaults.budget.maxCostMicrousd).toBe(0);

    for (const field of [
      "maxTurns",
      "maxWallClockMs",
      "maxToolCalls",
      "maxCostMicrousd",
      "maxFanout"
    ] as const) {
      expect(Number.isFinite(defaults.budget[field])).toBe(true);
    }

    expect(defaults.budget.unknownCostBlocks).toBe(true);
  });

  it("never weakens the five hard limits", () => {
    const defaults = buildLongHorizonDefaults();
    const baseline = {
      gates: {
        completionGateIds: Array.from(DEFAULT_COMPLETION_GATE_IDS),
        approvalPolicy: {
          autoCommitPushPr: true,
          allowLocalMerge: true,
          allowForcePush: true
        },
        reviewGate: { provider: "command" as const, required: false }
      },
      goal: { status: "active" as const, acceptanceCriteria: ["forbidden-shortcut"], sticky: true },
      rubric: { sticky: true, criteria: ["forbidden-grading"] },
      plan: { rePlanOnBlocked: false, requireEvidenceOnResume: false },
      budget: {
        maxTurns: Number.POSITIVE_INFINITY,
        maxWallClockMs: Number.POSITIVE_INFINITY,
        maxToolCalls: Number.POSITIVE_INFINITY,
        maxCostMicrousd: Number.POSITIVE_INFINITY,
        maxFanout: Number.POSITIVE_INFINITY,
        unknownCostBlocks: false as const
      }
    } as unknown as LongHorizonDefaults;

    const violations = LongHorizonDefaultsSchema.safeParse(baseline).success;

    expect(violations).toBe(false);

    const stricter = LongHorizonDefaultsSchema.safeParse({
      ...defaults,
      gates: {
        ...defaults.gates,
        approvalPolicy: { ...defaults.gates.approvalPolicy, autoCommitPushPr: true }
      }
    });

    expect(stricter.success).toBe(false);
  });

  it("deep-freezes the returned object so consumers cannot mutate it", () => {
    const first = buildLongHorizonDefaults();
    const second = buildLongHorizonDefaults();

    expect(first).not.toBe(second);
    expect(first.gates.completionGateIds).not.toBe(second.gates.completionGateIds);

    expect(() => {
      (first.gates.completionGateIds as string[]).push("rogue");
    }).toThrow();

    expect(() => {
      (first.budget as { maxTurns: number }).maxTurns = Number.POSITIVE_INFINITY;
    }).toThrow();

    expect(() => {
      (first.gates.approvalPolicy as { autoCommitPushPr: boolean }).autoCommitPushPr = true;
    }).toThrow();
  });
});
