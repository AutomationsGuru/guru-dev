import { describe, expect, it } from "vitest";

import {
  buildPlan,
  CompositeCheckInputSchema,
  CompositeEditInputSchema,
  CompositePlanSchema,
  EmptyCompositeEditError
} from '../../src/tools/compositeEditAndCheck.js';

describe("buildPlan (composite edit + check)", () => {
  it("returns steps in edit-then-check order with both kinds present", () => {
    const plan = buildPlan(
      { path: "src/example.ts", mode: "createOnly", summary: "Add helper" },
      { command: "npm test", cwd: "." }
    );

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.kind).toBe("edit");
    expect(plan.steps[1]?.kind).toBe("check");

    // Order is enforced by array position; ids stay stable for log/UI plumbing.
    expect(plan.steps.map((step) => step.id)).toEqual(["step.edit", "step.check"]);
    expect(plan.steps[0]?.edit).toEqual({
      path: "src/example.ts",
      mode: "createOnly",
      summary: "Add helper"
    });
    expect(plan.steps[1]?.check).toEqual({
      command: "npm test",
      cwd: ".",
      timeoutMs: undefined
    });
  });

  it("preserves the edit payload at position 0 even when the check has a long command", () => {
    const plan = buildPlan(
      { path: "README.md", mode: "overwrite", summary: "Rewrite intro section" },
      { command: "node ./scripts/lint-readme.js --strict --no-cache", timeoutMs: 30_000 }
    );

    expect(plan.steps[0]?.kind).toBe("edit");
    expect(plan.steps[0]?.edit?.path).toBe("README.md");
    expect(plan.steps[0]?.edit?.mode).toBe("overwrite");
    expect(plan.steps[1]?.kind).toBe("check");
    expect(plan.steps[1]?.check?.command).toBe("node ./scripts/lint-readme.js --strict --no-cache");
    expect(plan.steps[1]?.check?.timeoutMs).toBe(30_000);
  });

  it("marks the plan as describes-only (no execution by the builder)", () => {
    const plan = buildPlan(
      { path: "src/example.ts", mode: "createOnly", summary: "Add helper" },
      { command: "npm test" }
    );

    expect(plan.describesOnly).toBe(true);
  });

  it("round-trips through CompositePlanSchema", () => {
    const plan = buildPlan(
      { path: "src/example.ts", mode: "exactReplace", summary: "Patch handler" },
      { command: "vitest run tests/example.test.ts" }
    );

    const parsed = CompositePlanSchema.parse(plan);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]?.kind).toBe("edit");
    expect(parsed.steps[1]?.kind).toBe("check");
  });

  it("accepts a caller-supplied plan id and preserves it", () => {
    const plan = buildPlan(
      { path: "src/example.ts", mode: "createOnly", summary: "Add helper" },
      { command: "npm test" },
      { id: "plan.custom-id" }
    );

    expect(plan.id).toBe("plan.custom-id");
  });
});

describe("buildPlan rejection paths", () => {
  it("rejects an empty path in the edit (CompositeEditInputSchema contract)", () => {
    expect(() =>
      buildPlan(
        { path: "", mode: "createOnly", summary: "Add helper" },
        { command: "npm test" }
      )
    ).toThrow(EmptyCompositeEditError);
  });

  it("rejects a whitespace-only path in the edit", () => {
    expect(() =>
      buildPlan(
        { path: "   ", mode: "createOnly", summary: "Add helper" },
        { command: "npm test" }
      )
    ).toThrow(EmptyCompositeEditError);
  });

  it("rejects an empty summary in the edit (the empty-edit gate)", () => {
    expect(() =>
      buildPlan(
        { path: "src/example.ts", mode: "createOnly", summary: "" },
        { command: "npm test" }
      )
    ).toThrow(EmptyCompositeEditError);
  });

  it("rejects a whitespace-only summary in the edit", () => {
    expect(() =>
      buildPlan(
        { path: "src/example.ts", mode: "createOnly", summary: "   \t  " },
        { command: "npm test" }
      )
    ).toThrow(EmptyCompositeEditError);
  });

  it("rejects an unknown edit mode", () => {
    expect(() =>
      buildPlan(
        // Schema-strict: invalid `mode` is rejected before reaching the
        // empty-edit gate so we surface a clearer error.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { path: "src/example.ts", mode: "splice" as any, summary: "Add helper" },
        { command: "npm test" }
      )
    ).toThrow(EmptyCompositeEditError);
  });

  it("rejects an empty check command", () => {
    expect(() =>
      buildPlan(
        { path: "src/example.ts", mode: "createOnly", summary: "Add helper" },
        { command: "" }
      )
    ).toThrow(/Composite check rejected/);
  });
});

describe("input schema sanity (guard rails)", () => {
  it("CompositeEditInputSchema rejects missing summary", () => {
    const result = CompositeEditInputSchema.safeParse({
      path: "src/example.ts",
      mode: "createOnly"
    });

    expect(result.success).toBe(false);
  });

  it("CompositeCheckInputSchema rejects non-positive timeoutMs", () => {
    const result = CompositeCheckInputSchema.safeParse({
      command: "npm test",
      timeoutMs: 0
    });

    expect(result.success).toBe(false);
  });
});
