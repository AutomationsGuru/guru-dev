import { describe, expect, it } from "vitest";

import type { ChildBranch } from "../../src/guru/sessionLog.js";
import { buildSessionTree, foldLabel, renderTreePlain } from "../../src/guru/sessionTree.js";

const session = {
  title: "Auth work",
  messages: [
    { role: "system" as const, content: "system prompt here" },
    { role: "user" as const, content: "explain the auth flow please" },
    { role: "assistant" as const, content: "The auth flow works by\nissuing a token…" },
    { role: "user" as const, content: "now refactor it" },
    { role: "assistant" as const, content: "Done." }
  ],
  entryIds: ["e0", "e1", "e2", "e3", "e4"]
};

describe("buildSessionTree", () => {
  it("numbers user messages as fork targets, maps number → entry id", () => {
    const tree = buildSessionTree(session, []);
    expect(tree.forkTargets.get(1)).toBe("e1");
    expect(tree.forkTargets.get(2)).toBe("e3");
    const userRows = tree.rows.filter((row) => row.role === "user");
    expect(userRows.map((row) => row.forkNumber)).toEqual([1, 2]);
  });

  it("default filter = conversation (user+assistant), hides system", () => {
    const rows = buildSessionTree(session, []).rows;
    expect(rows.some((row) => row.role === "system")).toBe(false);
    expect(rows.filter((row) => row.role === "assistant")).toHaveLength(2);
  });

  it("filter=user shows only user turns; filter=all includes system", () => {
    expect(buildSessionTree(session, [], { filter: "user" }).rows.every((row) => row.role === "user")).toBe(true);
    expect(buildSessionTree(session, [], { filter: "all" }).rows.some((row) => row.role === "system")).toBe(true);
  });

  it("branches attach under the message they forked from", () => {
    const children: ChildBranch[] = [
      { sessionId: "child-1", title: "auth experiment", parentEntryId: "e3", branchSummary: "tried JWT", turnCount: 3, updatedAt: "t" }
    ];
    const rows = buildSessionTree(session, children).rows;
    const branchIndex = rows.findIndex((row) => row.kind === "branch");
    expect(branchIndex).toBeGreaterThan(0);
    expect(rows[branchIndex]?.childSessionId).toBe("child-1");
    // It follows the "now refactor it" (e3) row.
    const prior = rows.slice(0, branchIndex).reverse().find((row) => row.kind === "message");
    expect(prior?.entryId).toBe("e3");
  });

  it("a branch whose fork point isn't shown still surfaces (never dropped)", () => {
    const children: ChildBranch[] = [
      { sessionId: "orphan", title: "stray", parentEntryId: "does-not-exist", turnCount: 1, updatedAt: "t" }
    ];
    const rows = buildSessionTree(session, children).rows;
    expect(rows.some((row) => row.childSessionId === "orphan")).toBe(true);
  });

  it("foldLabel collapses whitespace and truncates", () => {
    expect(foldLabel("a\n\n  b   c")).toBe("a b c");
    expect(foldLabel("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("renderTreePlain marks fork numbers and roles", () => {
    const lines = renderTreePlain(buildSessionTree(session, []));
    expect(lines[0]).toContain("Auth work");
    expect(lines.some((line) => line.includes("[1]") && line.includes("you:"))).toBe(true);
    expect(lines.some((line) => line.includes("guru:"))).toBe(true);
  });
});
