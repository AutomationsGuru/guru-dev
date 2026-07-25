import { route, type RouterMode } from '../../src/planning/vibeVsSpecRouter.js';

describe("route", () => {
  it("routes a typo fix to vibe", () => {
    expect(route("fix the typo in the README")).toBe("vibe");
  });

  it("routes a structured auth-system request to spec", () => {
    expect(route("implement an auth system with login and sessions")).toBe("spec");
  });

  it("routes a regression report to bugfix", () => {
    expect(route("regression: exports fail after upgrade")).toBe("bugfix");
  });

  it("routes multi-file work to spec", () => {
    expect(route("update the config handling across multiple files")).toBe("spec");
  });

  it("routes substantive defects to bugfix before structured hints", () => {
    expect(route("fix the broken auth system")).toBe("bugfix");
  });

  it("keeps trivial touch-ups in vibe despite fix language", () => {
    expect(route("quick fix: adjust the comment wording")).toBe("vibe");
  });

  it("is case-insensitive", () => {
    expect(route("IMPLEMENT A NEW FEATURE")).toBe("spec");
    expect(route("REGRESSION IN EXPORTS")).toBe("bugfix");
  });

  it("defaults short or empty prompts to vibe", () => {
    const modes: RouterMode[] = [route(""), route("   \n\t"), route("rename this variable")];

    expect(modes).toEqual(["vibe", "vibe", "vibe"]);
  });
});
