import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const require = createRequire(import.meta.url);
const plannerKeyEnvVar = "GURU_DRY_RUN_TEST_KEY";
const syntheticPlannerKey = "synthetic-dry-run-key-never-send";

interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly configPath: string;
  readonly commandPath: string;
  readonly gitMarker: string;
}

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly error?: Error;
}

function createFixture(gitPresent: boolean): Fixture {
  const root = mkdtempSync(join(tmpdir(), "guruharness-dev-cycle-dry-run-"));
  const project = join(root, "project");
  const commandDirectory = join(root, "commands");
  const configPath = join(root, "guruharness.config.json");
  const gitMarker = join(root, "git-was-executed.txt");
  mkdirSync(project);
  mkdirSync(commandDirectory);

  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ scripts: { test: "node -e \"require('node:fs').writeFileSync('gate-was-executed.txt', 'x')\"" } }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        plannerModel: {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "dry-run-test-model",
          apiKeyEnvVar: plannerKeyEnvVar
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  if (process.platform === "win32") {
    if (gitPresent) {
      writeFileSync(join(commandDirectory, "git.cmd"), `@echo off\r\n> "${gitMarker}" echo invoked\r\n`, "utf8");
    }
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) {
      throw new Error("SystemRoot is required for the Windows command-presence fixture.");
    }
    return {
      root,
      project,
      configPath,
      commandPath: `${commandDirectory}${delimiter}${join(systemRoot, "System32")}`,
      gitMarker
    };
  }

  const whichPath = join(commandDirectory, "which");
  writeFileSync(whichPath, gitPresent ? "#!/bin/sh\n[ \"$1\" = \"git\" ]\n" : "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(whichPath, 0o755);
  if (gitPresent) {
    const gitPath = join(commandDirectory, "git");
    writeFileSync(gitPath, `#!/bin/sh\nprintf invoked > "${gitMarker}"\n`, "utf8");
    chmodSync(gitPath, 0o755);
  }

  return { root, project, configPath, commandPath: commandDirectory, gitMarker };
}

function runDryRun(fixture: Fixture, plannerKey?: string): CliResult {
  const tsxImport = process.env.GURU_TEST_TSX_IMPORT ?? require.resolve("tsx");
  const externalNodeOptions = process.env.GURU_TEST_NODE_OPTIONS;
  const env: NodeJS.ProcessEnv = {
    PATH: fixture.commandPath,
    NODE_NO_WARNINGS: "1",
    ...(externalNodeOptions ? { NODE_OPTIONS: externalNodeOptions } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(plannerKey !== undefined ? { [plannerKeyEnvVar]: plannerKey } : {})
  };
  const result = spawnSync(
    process.execPath,
    ["--import", tsxImport, cliPath, "self-build-run", "--dry-run", "--cwd", fixture.project, "--config", fixture.configPath, "--task-id", "dry-run-wiring"],
    { cwd: fixture.project, encoding: "utf8", env, timeout: 30_000 }
  );

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    ...(result.error ? { error: result.error } : {})
  };
}

function inventory(root: string, current = root): readonly string[] {
  return readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = join(current, entry.name);
      const name = relative(root, absolute).replace(/\\/gu, "/");
      if (entry.isDirectory()) {
        return [`${name}/`, ...inventory(root, absolute)];
      }
      const sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      return [`${name}:${sha256}`];
    });
}

function expectSuccessfulPreview(result: CliResult): void {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.match(/Dev-cycle plan for task/gu)).toHaveLength(1);
  expect(result.stdout).toContain('Dev-cycle plan for task "dry-run-wiring"');
  expect(result.stdout).toMatch(/2\. • TEST\s+run 1 discovered gate\(s\): npm run test/u);
  expect(result.stdout).toMatch(/3\. • SMOKE\s+capability-smoke \+ one bounded self-call/u);
  expect(result.stdout).toContain("DRY RUN — nothing is executed");
}

describe("self-build-run --dry-run wiring honesty", { timeout: 60_000 }, () => {
  it("reflects configured reviewer, smoke, and git availability without executing any of them", () => {
    const fixture = createFixture(true);
    try {
      const before = inventory(fixture.root);
      const result = runDryRun(fixture, syntheticPlannerKey);

      expectSuccessfulPreview(result);
      expect(result.stdout).toMatch(/5\. • REVIEW\s+guru's live native critic panel/u);
      expect(result.stdout).toMatch(/6\. • SHIP\s+git commit\/push/u);
      expect(result.stdout).not.toContain(syntheticPlannerKey);
      expect(result.stdout).not.toContain("dry-run-test-model");
      expect(existsSync(fixture.gitMarker)).toBe(false);
      expect(inventory(fixture.root)).toEqual(before);

      const renderedStages = [...result.stdout.matchAll(/^\s+\d+\. [•○] ([A-Z]+)/gmu)].map((match) => match[1]?.toLowerCase());
      expect(renderedStages).toEqual(["select", "build", "test", "smoke", "debug", "review", "ship", "learn"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps REVIEW unwired when the planner config or its named key is absent or empty", () => {
    const fixture = createFixture(true);
    try {
      const before = inventory(fixture.root);
      for (const key of [undefined, ""] as const) {
        const result = runDryRun(fixture, key);
        expectSuccessfulPreview(result);
        expect(result.stdout).toMatch(/5\. ○ REVIEW\s+no reviewer wired/u);
      }
      expect(inventory(fixture.root)).toEqual(before);

      writeFileSync(fixture.configPath, "{}\n", "utf8");
      const beforeNoPlanner = inventory(fixture.root);
      const noPlannerResult = runDryRun(fixture, syntheticPlannerKey);
      expectSuccessfulPreview(noPlannerResult);
      expect(noPlannerResult.stdout).toMatch(/5\. ○ REVIEW\s+no reviewer wired/u);
      expect(existsSync(fixture.gitMarker)).toBe(false);
      expect(inventory(fixture.root)).toEqual(beforeNoPlanner);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports the durable-record SHIP path when git is absent", () => {
    const fixture = createFixture(false);
    try {
      const before = inventory(fixture.root);
      const result = runDryRun(fixture, syntheticPlannerKey);

      expectSuccessfulPreview(result);
      expect(result.stdout).toMatch(/6\. • SHIP\s+git absent\/unwired → durable on-disk change-record/u);
      expect(existsSync(fixture.gitMarker)).toBe(false);
      expect(inventory(fixture.root)).toEqual(before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
