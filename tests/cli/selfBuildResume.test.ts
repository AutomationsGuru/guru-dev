import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];
const scrubbedEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  ...(process.env.GURU_TEST_NODE_OPTIONS ? { NODE_OPTIONS: process.env.GURU_TEST_NODE_OPTIONS } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.TMP ? { TMP: process.env.TMP } : {})
};

function tempProject(): { readonly cwd: string; readonly configPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "guruharness-cli-resume-"));
  roots.push(cwd);
  const configPath = join(cwd, "guruharness.config.json");
  writeFileSync(configPath, "{}\n", "utf8");
  return { cwd, configPath };
}

function runCli(cliArgs: readonly string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: scrubbedEnv,
    timeout: 120_000
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("self-build-run --resume-cycle (G102)", { timeout: 180_000 }, () => {
  it("documents the project-local resume flag", () => {
    const result = runCli(["self-build-run", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--resume-cycle <id>");
  });

  it("creates a checkpoint for a new model-free run and keeps stdout as one JSON report", () => {
    const project = tempProject();
    const result = runCli([
      "self-build-run",
      "--cwd",
      project.cwd,
      "--config",
      project.configPath,
      "--task-id",
      "model-free-resume-fixture",
      "--allow-dirty-workspace"
    ]);
    const report = JSON.parse(result.stdout) as { readonly cycleId: string; readonly terminal: string };
    const checkpointPath = join(project.cwd, ".guru", "dev-cycles", `${report.cycleId}.json`);

    expect(result.stderr).toContain(`[self-build-run] cycle=${report.cycleId}`);
    expect(report.terminal).toBe("blocked");
    expect(result.status).toBe(1);
    expect(existsSync(checkpointPath)).toBe(true);
    expect(JSON.parse(readFileSync(checkpointPath, "utf8"))).toMatchObject({
      cycleId: report.cycleId,
      selectedTaskId: "model-free-resume-fixture",
      status: "blocked"
    });
  });

  it("loads a matching terminal checkpoint and executes no product stage again", () => {
    const project = tempProject();
    const first = runCli([
      "self-build-run",
      "--cwd",
      project.cwd,
      "--config",
      project.configPath,
      "--task-id",
      "terminal-resume-fixture",
      "--allow-dirty-workspace"
    ]);
    const initial = JSON.parse(first.stdout) as { readonly cycleId: string; readonly stages: readonly unknown[] };

    const resumed = runCli([
      "self-build-run",
      "--cwd",
      project.cwd,
      "--config",
      project.configPath,
      "--resume-cycle",
      initial.cycleId,
      "--allow-dirty-workspace"
    ]);
    const report = JSON.parse(resumed.stdout) as { readonly cycleId: string; readonly stages: readonly unknown[]; readonly summary: string };

    expect(report.cycleId).toBe(initial.cycleId);
    expect(report.stages).toEqual(initial.stages);
    expect(report.summary).toMatch(/terminal checkpoint/u);
    expect(resumed.stderr).toContain(`resume=${initial.cycleId}`);
  });

  it.each(["--task-id", "--dry-run", "--loop"])("rejects conflicting %s before creating checkpoint state", (flag) => {
    const project = tempProject();
    const args = ["self-build-run", "--cwd", project.cwd, "--resume-cycle", "cycle-conflict", flag];
    if (flag === "--task-id") {
      args.push("other-task");
    }

    const result = runCli(args);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/resume-cycle.*mutually exclusive|mutually exclusive.*resume-cycle/i);
    expect(existsSync(join(project.cwd, ".guru"))).toBe(false);
    if (flag === "--loop") {
      expect(result.stderr).toMatch(/loop.*resume|resume.*loop/i);
    }
  });

  it("reports unknown and corrupt project-local checkpoints without changing them", () => {
    const project = tempProject();
    const unknown = runCli(["self-build-run", "--cwd", project.cwd, "--resume-cycle", "unknown-cycle"]);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toMatch(/not found/i);

    const directory = join(project.cwd, ".guru", "dev-cycles");
    const corruptPath = join(directory, "corrupt-cycle.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(corruptPath, "{bad-json\n", "utf8");
    const corrupt = runCli(["self-build-run", "--cwd", project.cwd, "--resume-cycle", "corrupt-cycle"]);
    expect(corrupt.status).not.toBe(0);
    expect(corrupt.stderr).toMatch(/corrupt|invalid/i);
    expect(readFileSync(corruptPath, "utf8")).toBe("{bad-json\n");
  });
});
