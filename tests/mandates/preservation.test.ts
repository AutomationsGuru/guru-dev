import { describe, expect, it } from "vitest";

import { assessContentRemoval } from "../../src/mandates/preservation.js";

/** Build an n-line block ("line 0\nline 1\n…"), so split("\n").length === n. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

const NEVER_READ = {
  resolvePath: (p: string) => p,
  readExisting: () => {
    throw new Error("readExisting should not be called for edit");
  }
};

describe("assessContentRemoval — PRESERVE, DON'T REPLACE backstop", () => {
  it("flags an edit that GUTS a large block (30 → 4 lines)", () => {
    const verdict = assessContentRemoval("edit", { oldText: lines(30), newText: lines(4) }, NEVER_READ);
    expect(verdict).not.toBeNull();
    expect(verdict?.removedLines).toBe(26);
    expect(verdict?.reason).toContain("30 → 4");
  });

  it("ignores a small edit — the touched region is below the gut floor", () => {
    expect(assessContentRemoval("edit", { oldText: lines(6), newText: lines(1) }, NEVER_READ)).toBeNull();
  });

  it("ignores a trim that leaves over half standing (40 → 30 lines)", () => {
    // 10 lines removed (< 15) AND 30 survives (>= 50% of 40) — a trim, not a gutting.
    expect(assessContentRemoval("edit", { oldText: lines(40), newText: lines(30) }, NEVER_READ)).toBeNull();
  });

  it("ignores growth — an edit that expands content never fires", () => {
    expect(assessContentRemoval("edit", { oldText: lines(20), newText: lines(45) }, NEVER_READ)).toBeNull();
  });

  it("flags a write that OVERWRITES a rich file with a much shorter one (40 → 5 lines)", () => {
    const verdict = assessContentRemoval(
      "write",
      { path: "docs/spec.md", contents: lines(5) },
      { resolvePath: (p) => `/repo/${p}`, readExisting: () => lines(40) }
    );
    expect(verdict).not.toBeNull();
    expect(verdict?.removedLines).toBe(35);
  });

  it("ignores a write to a BRAND-NEW file (nothing to remove)", () => {
    const verdict = assessContentRemoval(
      "write",
      { path: "docs/new.md", contents: lines(3) },
      { resolvePath: (p) => `/repo/${p}`, readExisting: () => null }
    );
    expect(verdict).toBeNull();
  });

  it("ignores a write that EXPANDS an existing file (25 → 60 lines)", () => {
    const verdict = assessContentRemoval(
      "write",
      { path: "src/x.ts", contents: lines(60) },
      { resolvePath: (p) => p, readExisting: () => lines(25) }
    );
    expect(verdict).toBeNull();
  });

  it("skips DRY RUNS — a preview removes nothing", () => {
    expect(assessContentRemoval("edit", { oldText: lines(30), newText: lines(2), dryRun: true }, NEVER_READ)).toBeNull();
  });

  it("ignores tools that are not write/edit", () => {
    expect(assessContentRemoval("bash", { command: "echo hi" }, NEVER_READ)).toBeNull();
  });

  it("ignores an edit with empty oldText (no region to remove)", () => {
    expect(assessContentRemoval("edit", { oldText: "", newText: "" }, NEVER_READ)).toBeNull();
  });
});
