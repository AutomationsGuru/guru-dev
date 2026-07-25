import {
  BUGFIX_KEYWORDS,
  route,
  RouteResultSchema,
  SPEC_KEYWORDS,
  TRIVIAL_FIX_KEYWORDS,
  VIBE_KEYWORDS
} from '../../src/planning/vibeVsSpecRouter.js';

describe("route", () => {
  it("routes a trivial typo fix to vibe", () => {
    const result = route("fix the typo in the README");

    expect(result.mode).toBe("vibe");
    expect(RouteResultSchema.parse(result)).toEqual(result);
  });

  it("routes a structured build request to spec", () => {
    const result = route("implement an auth system with login, sessions, and OAuth");

    expect(result.mode).toBe("spec");
  });

  it("routes a regression report to bugfix", () => {
    const result = route("regression: exports fail after upgrade");

    expect(result.mode).toBe("bugfix");
  });

  it("routes an empty prompt to vibe", () => {
    expect(route("").mode).toBe("vibe");
  });

  it("routes a whitespace-only prompt to vibe", () => {
    expect(route("   \n\t  ").mode).toBe("vibe");
  });

  it("routes a multi-file scope signal to spec", () => {
    const result = route("update the config handling across multiple files");

    expect(result.mode).toBe("spec");
  });

  it("is deterministic: the same input twice yields the same output", () => {
    const first = route("implement a small cache layer");
    const second = route("implement a small cache layer");

    expect(second).toEqual(first);
  });

  it("is case-insensitive", () => {
    expect(route("FIX CRASH").mode).toBe("bugfix");
  });

  it("distinguishes a substantive bug from a trivial fix", () => {
    expect(route("there is a bug in the parser that crashes on empty input").mode).toBe("bugfix");
    expect(route("quick fix: adjust the comment wording").mode).toBe("vibe");
  });

  it("returns non-empty reasons for every mode", () => {
    for (const prompt of ["fix the typo", "implement a system", "regression in exports", "", "hello"]) {
      expect(route(prompt).reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("keyword lists", () => {
  it("exposes frozen heuristic keyword lists", () => {
    for (const list of [BUGFIX_KEYWORDS, SPEC_KEYWORDS, TRIVIAL_FIX_KEYWORDS, VIBE_KEYWORDS]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    }
  });
});
