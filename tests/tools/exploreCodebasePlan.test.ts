import { describe, expect, it } from "vitest";

import {
  buildPlan,
  EmptyExploreQueryError,
  ExploreCodebasePlanSchema,
  ExploreCodebaseQuerySchema
} from '../../src/tools/exploreCodebasePlan.js';

// ---------------------------------------------------------------------------
// Schema sanity — input
// ---------------------------------------------------------------------------

describe("ExploreCodebaseQuerySchema (input)", () => {
  it("accepts a non-empty query string", () => {
    const result = ExploreCodebaseQuerySchema.safeParse({ query: "auth module" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing query", () => {
    const result = ExploreCodebaseQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an empty query", () => {
    const result = ExploreCodebaseQuerySchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only query", () => {
    const result = ExploreCodebaseQuerySchema.safeParse({ query: "   " });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPlan — core behaviour
// ---------------------------------------------------------------------------

describe("buildPlan", () => {
  it("returns steps that are non-empty", () => {
    const plan = buildPlan("how routing works");
    expect(plan.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("includes a search step", () => {
    const plan = buildPlan("how routing works");
    const searchSteps = plan.steps.filter((step) => step.kind === "search");
    expect(searchSteps.length).toBeGreaterThanOrEqual(1);
    expect(searchSteps[0]?.search).toBe("how routing works");
  });

  it("includes a list-roots step", () => {
    const plan = buildPlan("how routing works");
    const rootsSteps = plan.steps.filter((step) => step.kind === "list-roots");
    expect(rootsSteps.length).toBeGreaterThanOrEqual(1);
    expect(rootsSteps[0]?.roots).toEqual(["."]);
  });

  it("includes a read step", () => {
    const plan = buildPlan("how routing works");
    const readSteps = plan.steps.filter((step) => step.kind === "read");
    expect(readSteps.length).toBeGreaterThanOrEqual(1);
    expect(readSteps[0]?.files).toEqual([]);
  });

  it("includes a summarize step", () => {
    const plan = buildPlan("how routing works");
    const summarizeSteps = plan.steps.filter((step) => step.kind === "summarize");
    expect(summarizeSteps.length).toBeGreaterThanOrEqual(1);
    expect(summarizeSteps[0]?.summarize).toContain("how routing works");
  });

  it("marks the plan as describes-only", () => {
    const plan = buildPlan("how routing works");
    expect(plan.describesOnly).toBe(true);
  });

  it("preserves the original query", () => {
    const plan = buildPlan("auth module");
    expect(plan.query).toBe("auth module");
  });

  it("round-trips through the output schema", () => {
    const plan = buildPlan("auth module");
    const reparsed = ExploreCodebasePlanSchema.parse(plan);
    expect(reparsed).toEqual(plan);
  });

  it("rejects an empty query (EmptyExploreQueryError)", () => {
    expect(() => buildPlan("")).toThrow(EmptyExploreQueryError);
  });

  it("rejects a whitespace-only query", () => {
    expect(() => buildPlan("   ")).toThrow(EmptyExploreQueryError);
  });

  it("accepts a custom plan id", () => {
    const plan = buildPlan("auth module", { id: "custom-id-42" });
    expect(plan.id).toBe("custom-id-42");
  });

  it("steps have non-empty labels", () => {
    const plan = buildPlan("how routing works");
    for (const step of plan.steps) {
      expect(step.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("steps are ordered: list-roots → search → read → summarize", () => {
    const plan = buildPlan("how routing works");
    const kinds = plan.steps.map((step) => step.kind);
    expect(kinds).toEqual(["list-roots", "search", "read", "summarize"]);
  });
});

// ---------------------------------------------------------------------------
// EmptyExploreQueryError
// ---------------------------------------------------------------------------

describe("EmptyExploreQueryError", () => {
  it("is an Error with a descriptive name", () => {
    const err = new EmptyExploreQueryError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EmptyExploreQueryError");
    expect(err.message.length).toBeGreaterThan(0);
  });
});