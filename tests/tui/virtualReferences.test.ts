import { describe, expect, it, vi } from "vitest";

import {
  appendTerminalTail,
  buildSessionReferenceSummary,
  readStagedGitDiff,
  type VirtualReferenceProviders
} from "../../src/tui/virtualReferences.js";

describe("Guru-native virtual references", () => {
  it("builds a session reference from branch summary, then compaction, then a bounded deterministic turn tail", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn-${index}-${"x".repeat(30)}`
    }));

    expect(buildSessionReferenceSummary({ branchSummary: "branch wins", compactionSummary: "older fold", messages })).toBe("branch wins");
    expect(buildSessionReferenceSummary({ compactionSummary: "fold wins", messages })).toBe("fold wins");

    const tail = buildSessionReferenceSummary({ messages }, { maxChars: 180, maxMessages: 6 });
    expect(tail).toContain("assistant: turn-19");
    expect(tail).not.toContain("turn-0");
    expect(tail?.length).toBeLessThanOrEqual(180);
  });

  it("runs only the fixed staged-diff argv through the narrow injected runner", async () => {
    const runner = vi.fn(async () => ({ status: 0, stdout: "staged patch\n", stderr: "" }));

    await expect(readStagedGitDiff("/repo", runner)).resolves.toBe("staged patch");
    expect(runner).toHaveBeenCalledWith("git", ["diff", "--cached", "--no-ext-diff", "--"], "/repo");
  });

  it("keeps a capped in-memory tail and never needs a shell or persistence surface", () => {
    const first = appendTerminalTail("", "first command\nfirst output\n", 36);
    const second = appendTerminalTail(first, "second command\nsecond output\n", 36);

    expect(second).toContain("second output");
    expect(Buffer.byteLength(second, "utf8")).toBeLessThanOrEqual(36);
    expect(second).not.toContain("first command");
  });

  it("exports the four narrow provider operations without a generic executor", () => {
    const providers: VirtualReferenceProviders = {
      sessionSummary: async () => null,
      memoryFacts: async () => null,
      stagedDiff: async () => null,
      terminalTail: async () => null
    };

    expect(Object.keys(providers).sort()).toEqual(["memoryFacts", "sessionSummary", "stagedDiff", "terminalTail"]);
  });
});
