import { describe, expect, it } from "vitest";

import { createBrief, assignWorker } from '../../src/swarm/teamBrief.js';
import { clampAllowlist, TeamBriefSchema } from '../../src/swarm/teamBriefSchema.js';
import { createSwarmManager } from '../../src/swarm/manager.js';

describe("team brief — schema validation", () => {
  it("parses a valid brief with all fields", () => {
    const raw = {
      goal: "Fix the login bug",
      ownedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      toolAllowlist: ["bash", "read_file", "write_file"],
      successChecks: ["All tests pass", "No type errors"],
    };
    const brief = TeamBriefSchema.parse(raw);
    expect(brief.goal).toBe("Fix the login bug");
    expect(brief.ownedPaths).toEqual(raw.ownedPaths);
    expect(brief.toolAllowlist).toEqual(raw.toolAllowlist);
    expect(brief.successChecks).toEqual(raw.successChecks);
  });

  it("defaults empty arrays when fields are omitted", () => {
    const brief = TeamBriefSchema.parse({ goal: "Scout the repo" });
    expect(brief.ownedPaths).toEqual([]);
    expect(brief.toolAllowlist).toEqual([]);
    expect(brief.successChecks).toEqual([]);
  });

  it("rejects empty goal (trimmed)", () => {
    expect(() => TeamBriefSchema.parse({ goal: "" })).toThrow();
    expect(() => TeamBriefSchema.parse({ goal: "   " })).toThrow();
  });

  it("rejects missing goal", () => {
    expect(() => TeamBriefSchema.parse({})).toThrow();
  });

  it("rejects goal exceeding max length", () => {
    expect(() => TeamBriefSchema.parse({ goal: "x".repeat(2001) })).toThrow();
  });

  it("rejects non-string fields in arrays", () => {
    expect(() =>
      TeamBriefSchema.parse({ goal: "test", toolAllowlist: [123] }),
    ).toThrow();
  });
});

describe("team brief — createBrief", () => {
  it("creates a valid brief from raw input with clamped allowlist", () => {
    const brief = createBrief({
      goal: "Refactor the parser",
      toolAllowlist: ["bash", "BASH", "  write_file  ", "", "read_file"],
    });
    expect(brief.goal).toBe("Refactor the parser");
    expect(brief.toolAllowlist).toEqual(["BASH", "bash", "read_file", "write_file"]);
  });

  it("rejects invalid input", () => {
    expect(() => createBrief({ goal: "" })).toThrow();
    expect(() => createBrief(null)).toThrow();
    expect(() => createBrief(undefined)).toThrow();
  });
});

describe("team brief — clampAllowlist", () => {
  it("deduplicates case-sensitively", () => {
    expect(clampAllowlist(["bash", "BASH", "bash"])).toEqual(["BASH", "bash"]);
  });

  it("trims whitespace and removes blanks", () => {
    expect(clampAllowlist(["  bash  ", "", "  ", "read_file"])).toEqual([
      "bash",
      "read_file",
    ]);
  });

  it("returns sorted results", () => {
    expect(clampAllowlist(["z", "a", "m"])).toEqual(["a", "m", "z"]);
  });

  it("returns empty array for empty/blanks-only input", () => {
    expect(clampAllowlist([])).toEqual([]);
    expect(clampAllowlist(["", "  "])).toEqual([]);
  });
});

describe("team brief — assignWorker", () => {
  it("spawns a worker whose prompt encodes the full brief", async () => {
    const manager = createSwarmManager({});

    // Capture the prompt the runner receives
    let capturedPrompt = "";
    manager.setRunner(async (request) => {
      capturedPrompt = request.prompt;
      return { text: "done", toolCallCount: 0 };
    });

    const brief = createBrief({
      goal: "Fix the login bug",
      ownedPaths: ["src/auth/login.ts"],
      toolAllowlist: ["bash", "read_file"],
      successChecks: ["All tests pass", "No type errors"],
    });

    const assignment = assignWorker(manager, brief, "read-only", "login-fix");
    await manager.drain();

    expect(assignment.taskId).toBeTruthy();
    expect(assignment.brief).toBe(brief);

    // Verify the prompt structure
    expect(capturedPrompt).toContain("## Goal");
    expect(capturedPrompt).toContain("Fix the login bug");
    expect(capturedPrompt).toContain("## Owned Paths");
    expect(capturedPrompt).toContain("src/auth/login.ts");
    expect(capturedPrompt).toContain("## Tools Allowlist");
    expect(capturedPrompt).toContain("bash");
    expect(capturedPrompt).toContain("read_file");
    expect(capturedPrompt).toContain("## Success Checks");
    expect(capturedPrompt).toContain("1. All tests pass");
    expect(capturedPrompt).toContain("2. No type errors");
  });

  it("handles a minimal brief with no paths, tools, or checks", async () => {
    const manager = createSwarmManager({});
    let capturedPrompt = "";
    manager.setRunner(async (request) => {
      capturedPrompt = request.prompt;
      return { text: "scouted", toolCallCount: 0 };
    });

    const brief = createBrief({ goal: "Scout the repo" });
    assignWorker(manager, brief);
    await manager.drain();

    expect(capturedPrompt).toContain("## Goal");
    expect(capturedPrompt).toContain("Scout the repo");
    expect(capturedPrompt).toContain("(none — no tool access granted)");
  });

  it("defaults to read-only mode when mode is not specified", async () => {
    const manager = createSwarmManager({});
    let capturedMode = "";
    manager.setRunner(async (request) => {
      capturedMode = request.mode;
      return { text: "ok", toolCallCount: 0 };
    });

    const brief = createBrief({ goal: "test" });
    assignWorker(manager, brief);
    await manager.drain();

    expect(capturedMode).toBe("read-only");
  });

  it("spawns with explicit 'all' mode", async () => {
    const manager = createSwarmManager({});
    let capturedMode = "";
    manager.setRunner(async (request) => {
      capturedMode = request.mode;
      return { text: "ok", toolCallCount: 0 };
    });

    const brief = createBrief({ goal: "mutate" });
    assignWorker(manager, brief, "all");
    await manager.drain();

    expect(capturedMode).toBe("all");
  });
});