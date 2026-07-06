import { describe, expect, it } from "vitest";

import { makeDevCycleReviewer, makeGitDiffGatherer } from "../../src/selfbuild/devCycleReview.js";
import type { CommandGate } from "../../src/review/gates.js";
import type { AskModel } from "../../src/review/nativeCriticPanel.js";

const gate: CommandGate = { kind: "review", name: "native-critic-panel", command: [], required: true, native: true };

describe("makeDevCycleReviewer (P7) — build the live reviewer from an askModel", () => {
  it("no askModel → undefined (REVIEW degrades to YELLOW)", () => {
    expect(makeDevCycleReviewer({})).toBeUndefined();
  });

  it("stub askModel that finds nothing → a working reviewer returning GREEN", async () => {
    const askModel: AskModel = async (_prompt, meta) => (meta.phase === "find" ? "[]" : JSON.stringify({ confirmed: false, reason: "n/a" }));
    const reviewer = makeDevCycleReviewer({ askModel, getReviewContext: async () => ({ diff: "a change" }) });
    expect(reviewer).toBeDefined();
    const result = await reviewer!(gate, process.cwd());
    expect(result.verdict).toBe("GREEN");
  });
});

describe("makeGitDiffGatherer (P7) — the review context is the uncommitted diff", () => {
  it("git present → returns the diff from the injected runner + the objective", async () => {
    const gather = makeGitDiffGatherer({ commandExists: () => true, runGit: () => "diff --git a/x b/x", objective: "obj" });
    const ctx = await gather("/repo");
    expect(ctx.diff).toMatch(/diff --git/u);
    expect(ctx.objective).toBe("obj");
  });

  it("git absent → empty diff, no crash", async () => {
    const gather = makeGitDiffGatherer({ commandExists: () => false });
    expect((await gather("/repo")).diff).toBe("");
  });
});
