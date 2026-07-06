import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGitHubPrCommentTool,
  createGitHubPrReviewTool,
  createGitHubPrStatusTool
} from "../../src/tools/builtins/githubPrTools.js";
import type { CommandExecutionContext, CommandExecutionResult } from "../../src/review/gates.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("GitHub PR tools", () => {
  it("should read PR status through the injected executor by default", async () => {
    const repoRoot = makeTempDirectory();
    const calls: Array<{ command: readonly string[]; context: CommandExecutionContext }> = [];
    const registry = createRegistry(async (command, context) => {
      calls.push({ command, context });
      return successResult('{"state":"OPEN"}');
    });

    const observation = await executeRegisteredTool(registry, "github.pr.status", {
      repoRoot,
      prNumber: 31,
      repo: "AutomationsGuru/GuruHarness"
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ executed: true, dryRun: false, exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual([
      "gh",
      "pr",
      "view",
      "31",
      "--json",
      "number,title,state,url,headRefName,baseRefName,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
      "--repo",
      "AutomationsGuru/GuruHarness"
    ]);
    expect(calls[0]?.context.cwd).toBe(repoRoot);
  });

  it("should dry-run PR comments by default and redact body in command output", async () => {
    const repoRoot = makeTempDirectory();
    const calls: Array<readonly string[]> = [];
    const registry = createRegistry(async (command) => {
      calls.push(command);
      return successResult("unexpected");
    });

    const observation = await executeRegisteredTool(registry, "github.pr.comment", {
      repoRoot,
      prNumber: 31,
      body: "Looks good."
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ executed: false, dryRun: true, command: ["gh", "pr", "comment", "31", "--body", "[redacted]"] });
    expect(calls).toHaveLength(0);
  });

  it("should execute PR comments only when dryRun is false", async () => {
    const repoRoot = makeTempDirectory();
    const calls: Array<readonly string[]> = [];
    const registry = createRegistry(async (command) => {
      calls.push(command);
      return successResult("posted");
    });

    const observation = await executeRegisteredTool(registry, "github.pr.comment", {
      repoRoot,
      prNumber: 31,
      body: "Posted after approval.",
      dryRun: false
    });

    expect(observation.output).toMatchObject({ executed: true, dryRun: false, command: ["gh", "pr", "comment", "31", "--body", "[redacted]"] });
    expect(calls).toEqual([["gh", "pr", "comment", "31", "--body", "Posted after approval."]]);
  });

  it("should block secret-like review bodies without leaking the value", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry(async () => successResult("unexpected"));
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";

    const observation = await executeRegisteredTool(registry, "github.pr.review", {
      repoRoot,
      prNumber: 31,
      action: "comment",
      body: `token=${secret}`,
      dryRun: false
    });

    expect(observation.output).toMatchObject({ executed: false, dryRun: false });
    expect(JSON.stringify(observation.output)).toContain("github-token");
    expect(JSON.stringify(observation.output)).not.toContain(secret);
  });

  it("should require bodies for request-changes and comment reviews", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry(async () => successResult("unexpected"));

    const observation = await executeRegisteredTool(registry, "github.pr.review", {
      repoRoot,
      prNumber: 31,
      action: "request-changes",
      dryRun: false
    });

    expect(observation.output).toMatchObject({ executed: false });
    expect(JSON.stringify(observation.output)).toContain("requires a body");
  });
});

function createRegistry(
  executor: (command: readonly string[], context: CommandExecutionContext) => Promise<CommandExecutionResult>
) {
  return createToolRegistry([
    createGitHubPrStatusTool({ executor, secretAllowList: [] }),
    createGitHubPrCommentTool({ executor, secretAllowList: [] }),
    createGitHubPrReviewTool({ executor, secretAllowList: [] })
  ]);
}

function successResult(stdout: string): CommandExecutionResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1
  };
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-github-tool-"));
  tempDirectories.push(directory);

  return directory;
}
