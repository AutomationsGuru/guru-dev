import { describe, expect, it } from "vitest";

import { buildDevCyclePlan, renderDevCyclePlan } from "../../src/selfbuild/devCyclePlan.js";

/** Read-only fake FS keyed by basename (matches the paths discoverGates builds). */
function fakeFs(files: Record<string, string>) {
  const match = (path: string): string | undefined => {
    const norm = path.replace(/\\/gu, "/");
    return Object.keys(files).find((f) => norm.endsWith(`/${f}`) || norm.endsWith(f));
  };
  return {
    exists: (path: string) => match(path) !== undefined,
    readFile: (path: string) => {
      const key = match(path);
      if (!key) {
        throw new Error("ENOENT");
      }
      return files[key]!;
    }
  };
}

describe("buildDevCyclePlan (P7 --dry-run) — preview only", () => {
  it("lists the discovered gates in TEST and the full 0→7 stage order", () => {
    const plan = buildDevCyclePlan({
      cwd: "/repo",
      taskId: "t",
      discover: fakeFs({ "package.json": JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }) })
    });
    expect(plan.stages.map((s) => s.stage)).toEqual(["select", "build", "test", "smoke", "debug", "review", "ship", "learn"]);
    const test = plan.stages.find((s) => s.stage === "test");
    expect(test?.willRun).toBe(true);
    expect(test?.action).toMatch(/npm run test/u);
    expect(plan.gates).toHaveLength(2);
  });

  it("no gates → TEST won't run (YELLOW); reviewer/smoke unwired → won't run", () => {
    const plan = buildDevCyclePlan({ cwd: "/repo", discover: fakeFs({ "README.md": "x" }) });
    expect(plan.stages.find((s) => s.stage === "test")?.willRun).toBe(false);
    expect(plan.stages.find((s) => s.stage === "review")?.willRun).toBe(false);
    expect(plan.stages.find((s) => s.stage === "smoke")?.willRun).toBe(false);
  });

  it("hasReviewer/hasSmoke/hasGitDelivery flip willRun + the wording", () => {
    const plan = buildDevCyclePlan({ cwd: "/repo", hasReviewer: true, hasSmoke: true, hasGitDelivery: true, discover: fakeFs({}) });
    expect(plan.stages.find((s) => s.stage === "review")?.willRun).toBe(true);
    expect(plan.stages.find((s) => s.stage === "smoke")?.willRun).toBe(true);
    expect(plan.stages.find((s) => s.stage === "ship")?.action).toMatch(/git commit/u);
  });

  it("notes state the $0 spend gate + budget bounds and render as text", () => {
    const plan = buildDevCyclePlan({ cwd: "/repo", discover: fakeFs({}) });
    expect(plan.notes[0]).toMatch(/DRY RUN/u);
    expect(plan.notes.join(" ")).toMatch(/\$0 \(0 denies all spend\)/u);
    const text = renderDevCyclePlan(plan);
    expect(text).toMatch(/SELECT/u);
    expect(text).toMatch(/DRY RUN/u);
  });
});
