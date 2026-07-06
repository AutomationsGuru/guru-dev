import {
  createGitPrAutomationPlan,
  runGitPrAutomation,
  type GitPrAutomationRequest
} from "../../src/git/prAutomation.js";
import type { CommandExecutor } from "../../src/review/gates.js";
import { createGitPrAutomationTool } from "../../src/tools/builtins/gitPrAutomationTool.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

describe("createGitPrAutomationPlan", () => {
  it("should create a safe git add commit push and PR plan", () => {
    const plan = createGitPrAutomationPlan(createRequest());

    expect(plan.map((step) => step.name)).toEqual(["git-status", "git-add", "git-commit", "git-push", "gh-pr-create"]);
    expect(plan[1]?.command).toEqual(["git", "-C", "repo", "add", "--", "src/index.ts"]);
    expect(plan[3]?.command).toEqual(["git", "-C", "repo", "push", "-u", "origin", "feat/example"]);
    expect(plan[4]?.command).toContain("pr");
    expect(plan.flatMap((step) => step.command)).not.toContain("--force");
    expect(plan.flatMap((step) => step.command)).not.toContain("merge");
  });

  it("should reject direct automation on protected branches", () => {
    expect(() => createGitPrAutomationPlan(createRequest({ branchName: "main" }))).toThrow(
      "Refusing to automate directly on protected branch: main"
    );
  });

  it("should reject unsafe dash-prefixed git arguments", () => {
    expect(() => createGitPrAutomationPlan(createRequest({ paths: ["--all"] }))).toThrow(
      "Refusing unsafe git argument: --all"
    );
  });
});

describe("runGitPrAutomation", () => {
  it("should plan steps without executing when dryRun is true", async () => {
    const executedCommands: string[][] = [];
    const report = await runGitPrAutomation(createRequest({ dryRun: true }), {
      executor: createRecordingExecutor(executedCommands)
    });

    expect(report).toMatchObject({ verdict: "GREEN", dryRun: true });
    expect(report.steps.map((step) => step.status)).toEqual(["planned", "planned", "planned", "planned", "planned"]);
    expect(executedCommands).toHaveLength(0);
  });

  it("should execute each step when dryRun is false", async () => {
    const executedCommands: string[][] = [];
    const report = await runGitPrAutomation(createRequest({ dryRun: false }), {
      executor: createRecordingExecutor(executedCommands)
    });

    expect(report).toMatchObject({ verdict: "GREEN", dryRun: false });
    expect(report.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(executedCommands).toHaveLength(5);
  });

  it("should stop on the first failed step", async () => {
    const executor: CommandExecutor = async (command) => ({
      exitCode: command.includes("commit") ? 1 : 0,
      stdout: "",
      stderr: command.includes("commit") ? "commit failed" : "",
      durationMs: 1
    });

    const report = await runGitPrAutomation(createRequest({ dryRun: false }), { executor });

    expect(report).toMatchObject({ verdict: "RED", dryRun: false });
    expect(report.steps.map((step) => step.name)).toEqual(["git-status", "git-add", "git-commit"]);
    expect(report.steps.at(-1)).toMatchObject({ status: "failed", stderr: "commit failed" });
  });
});

describe("createGitPrAutomationTool", () => {
  it("should expose git PR automation through the tool registry", async () => {
    const registry = createToolRegistry([createGitPrAutomationTool(createRecordingExecutor([]))]);

    const observation = await executeRegisteredTool(registry, "git.pr.run", createRequest({ dryRun: true }));

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ verdict: "GREEN", dryRun: true });
    expect((observation.output as { steps: Array<{ name: string; status: string }> }).steps[0]).toMatchObject({
      name: "git-status",
      status: "planned"
    });
  });
});

function createRequest(overrides: Partial<GitPrAutomationRequest> = {}): GitPrAutomationRequest {
  return {
    repoRoot: "repo",
    baseBranch: "main",
    branchName: "feat/example",
    commitMessage: "feat: example",
    prTitle: "feat: example",
    prBody: "Adds example automation.",
    paths: ["src/index.ts"],
    remote: "origin",
    draft: false,
    dryRun: false,
    ...overrides
  };
}

function createRecordingExecutor(executedCommands: string[][]): CommandExecutor {
  return async (command) => {
    executedCommands.push([...command]);

    return {
      exitCode: 0,
      stdout: command.join(" "),
      stderr: "",
      durationMs: 1
    };
  };
}
