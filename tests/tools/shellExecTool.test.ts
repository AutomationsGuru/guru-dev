import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createShellExecTool } from "../../src/tools/builtins/shellExecTool.js";
import type { CommandExecutionContext, CommandExecutionResult } from "../../src/review/gates.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("createShellExecTool", () => {
  it("returns a dry-run plan without executing", async () => {
    const repoRoot = makeTempDirectory();
    const calls: Array<readonly string[]> = [];
    const registry = createRegistry(async (command) => {
      calls.push(command);
      return successResult("unexpected");
    });

    const observation = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      command: ["npm", "test"],
      dryRun: true
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ executed: false, dryRun: true, blockers: [] });
    expect(calls).toEqual([]);
  });

  it("executes an allowlisted command through the injected executor", async () => {
    const repoRoot = makeTempDirectory();
    const calls: Array<{ command: readonly string[]; context: CommandExecutionContext }> = [];
    const registry = createRegistry(async (command, context) => {
      calls.push({ command, context });
      return successResult("ok");
    });

    const observation = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      command: ["npm", "test"],
      dryRun: false
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ executed: true, dryRun: false, exitCode: 0, stdout: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual(["npm", "test"]);
    expect(calls[0]?.context.cwd).toBe(repoRoot);
    expect(calls[0]?.context.gate.name).toBe("shell.command.run");
  });

  it("blocks non-allowlisted executables and dashed arguments", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry(async () => successResult("unexpected"));

    const nonAllowlisted = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      command: ["rm", "file.txt"],
      dryRun: false
    });
    const dashedArg = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      command: ["git", "--version"],
      dryRun: false
    });

    expect(nonAllowlisted.output).toMatchObject({ executed: false });
    expect(JSON.stringify(nonAllowlisted.output)).toContain("not allowlisted");
    expect(dashedArg.output).toMatchObject({ executed: false });
    expect(JSON.stringify(dashedArg.output)).toContain("starting with '-' are blocked");
  });

  it("blocks cwd paths that escape the repository root", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry(async () => successResult("unexpected"));

    const observation = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      cwd: "../outside",
      command: ["npm", "test"],
      dryRun: false
    });

    expect(observation.output).toMatchObject({ executed: false });
    expect(JSON.stringify(observation.output)).toContain("cwd escapes the repository root");
  });

  it("redacts blocked secret arguments", async () => {
    const repoRoot = makeTempDirectory();
    const registry = createRegistry(async () => successResult("unexpected"));
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";

    const observation = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      command: ["node", secret],
      dryRun: false
    });

    expect(observation.output).toMatchObject({ executed: false, command: ["node", "[redacted]"] });
    expect(JSON.stringify(observation.output)).toContain("github-token");
    expect(JSON.stringify(observation.output)).not.toContain(secret);
  });

  it("redacts sensitive stdout and stderr from executed commands", async () => {
    const repoRoot = makeTempDirectory();
    const secret = "sk_test_1234567890abcdefghijklmnop";
    const registry = createRegistry(async () => successResult(`token=${secret}`));

    const observation = await executeRegisteredTool(registry, "shell.command.run", {
      repoRoot,
      command: ["node", "script.js"],
      dryRun: false
    });

    expect(observation.output).toMatchObject({ executed: true, stdout: "[redacted: sensitive output detected]" });
    expect(JSON.stringify(observation.output)).toContain("stripe-secret-key");
    expect(JSON.stringify(observation.output)).not.toContain(secret);
  });
});

function createRegistry(
  executor: (command: readonly string[], context: CommandExecutionContext) => Promise<CommandExecutionResult>
) {
  return createToolRegistry([
    createShellExecTool({
      executor,
      shellAllowlist: ["npm", "node", "git"],
      secretAllowList: []
    })
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
  const directory = mkdtempSync(join(tmpdir(), "guruharness-shell-tool-"));
  tempDirectories.push(directory);

  return directory;
}
