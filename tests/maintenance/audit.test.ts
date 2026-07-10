import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessConfigSchema } from "../../src/config/schema.js";
import { createSelfBuildState } from "../../src/kernel/selfBuildLoop.js";
import { createMaintenanceChecks, runMaintenanceAudit } from "../../src/maintenance/audit.js";
import { createMaintenanceAuditTool } from "../../src/tools/builtins/maintenanceAuditTool.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("runMaintenanceAudit", () => {
  it("should return GREEN when baseline maintenance surfaces are healthy", () => {
    const repoRoot = createHealthyRepo();

    const report = runMaintenanceAudit({ cwd: repoRoot });

    expect(report.verdict).toBe("GREEN");
    expect(report.checks.map((check) => check.id)).toEqual([
      "repo-context",
      "config-health",
      "validation-commands",
      "review-gate",
      "approval-policy",
      "self-build-progress",
      "direction-alignment",
      "skill-catalog",
      "documentation"
    ]);
    expect(report.summary).toBe("GREEN: 9/9 maintenance check(s) passed.");
  });

  it("should return RED when required documentation surfaces are missing", () => {
    const repoRoot = makeTempDirectory();
    writeFileSync(join(repoRoot, "AGENTS.md"), "repo contract");
    writeFileSync(join(repoRoot, "guruharness.config.json"), JSON.stringify(createHealthyConfig()));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });

    const report = runMaintenanceAudit({ cwd: repoRoot });

    expect(report.verdict).toBe("RED");
    expect(report.checks.find((check) => check.id === "documentation")).toMatchObject({ status: "failed" });
  });
});

describe("createMaintenanceChecks", () => {
  it("should warn when baseline validation commands are incomplete", () => {
    const config = HarnessConfigSchema.parse({ validationCommands: [{ name: "test", command: ["npm", "test"] }] });
    const checks = createMaintenanceChecks(
      {
        repoRoot: "repo",
        targetPath: "repo",
        gitStatus: "## main",
        agentsChain: [{ path: "repo/AGENTS.md", relativePath: "AGENTS.md", contents: "contract" }]
      },
      config,
      "GREEN"
    );

    expect(checks.find((check) => check.id === "validation-commands")).toMatchObject({ status: "warning" });
  });

  it("should fail when the approval policy allows unsafe operations", () => {
    const config = HarnessConfigSchema.parse({ approvalPolicy: { allowForcePush: true } });
    const checks = createMaintenanceChecks(
      {
        repoRoot: "repo",
        targetPath: "repo",
        gitStatus: "## main",
        agentsChain: [{ path: "repo/AGENTS.md", relativePath: "AGENTS.md", contents: "contract" }]
      },
      config,
      "GREEN"
    );

    expect(checks.find((check) => check.id === "approval-policy")).toMatchObject({ status: "failed" });
  });

  it("should pass self-build progress when every task is complete", () => {
    const config = HarnessConfigSchema.parse({
      selfBuild: { completedTaskIds: createSelfBuildState().tasks.map((task) => task.id) }
    });
    const checks = createMaintenanceChecks(
      {
        repoRoot: "repo",
        targetPath: "repo",
        gitStatus: "## main",
        agentsChain: [{ path: "repo/AGENTS.md", relativePath: "AGENTS.md", contents: "contract" }]
      },
      config,
      "GREEN"
    );

    expect(checks.find((check) => check.id === "self-build-progress")).toMatchObject({
      status: "passed",
      evidence: ["all-tasks-complete"]
    });
  });

  it("should pass direction alignment when the next task declares a THERE contribution", () => {
    const config = HarnessConfigSchema.parse({
      selfBuild: {
        completedTaskIds: [
          "capture-operating-contract",
          "core-result-contracts",
          "supabase-operational-store",
          "self-build-loop",
          "config-loader",
          "tool-registry",
          "repo-context-layer",
          "review-gates",
          "git-pr-automation",
          "maintenance-loop",
          "supabase-runtime-adapter",
          "skill-loader",
          "direction-gate",
          "harness-runtime-nucleus"
        ]
      }
    });
    const checks = createMaintenanceChecks(
      {
        repoRoot: "repo",
        targetPath: "repo",
        gitStatus: "## main",
        agentsChain: [{ path: "repo/AGENTS.md", relativePath: "AGENTS.md", contents: "contract" }]
      },
      config,
      "GREEN"
    );

    expect(checks.find((check) => check.id === "direction-alignment")).toMatchObject({
      status: "passed",
      summary: expect.stringContaining("planner-runtime")
    });
  });

  it("should warn when skills are discovered with catalog diagnostics", () => {
    const repoRoot = makeTempDirectory();
    mkdirSync(join(repoRoot, "skills", "guruharness-self-build"), { recursive: true });
    writeFileSync(
      join(repoRoot, "skills", "guruharness-self-build", "SKILL.md"),
      "---\nname: guruharness-self-build\ndescription: Test skill.\n---\n# Self Build\n"
    );
    const config = HarnessConfigSchema.parse({ skillDirectories: ["skills", "missing-skills"] });
    const checks = createMaintenanceChecks(
      {
        repoRoot,
        targetPath: repoRoot,
        gitStatus: "## main",
        agentsChain: [{ path: join(repoRoot, "AGENTS.md"), relativePath: "AGENTS.md", contents: "contract" }]
      },
      config,
      "GREEN"
    );

    expect(checks.find((check) => check.id === "skill-catalog")).toMatchObject({ status: "warning" });
  });
});

describe("createMaintenanceAuditTool", () => {
  it("should expose maintenance audit through the tool registry", async () => {
    const repoRoot = createHealthyRepo();
    const registry = createToolRegistry([createMaintenanceAuditTool()]);

    const observation = await executeRegisteredTool(registry, "maintenance.audit.run", { cwd: repoRoot });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ verdict: "GREEN" });
  });
});

function createHealthyRepo(): string {
  const repoRoot = makeTempDirectory();
  mkdirSync(join(repoRoot, "docs", "coordination"), { recursive: true });
  mkdirSync(join(repoRoot, "docs", "decisions"), { recursive: true });
  mkdirSync(join(repoRoot, "skills", "guruharness-self-build"), { recursive: true });
  writeFileSync(join(repoRoot, "AGENTS.md"), "repo contract");
  writeFileSync(join(repoRoot, "README.md"), "# Repo\n");
  writeFileSync(join(repoRoot, "docs", "coordination", "current-state.md"), "# State\n");
  writeFileSync(
    join(repoRoot, "skills", "guruharness-self-build", "SKILL.md"),
    "---\nname: guruharness-self-build\ndescription: Test skill.\n---\n# Self Build\n\nUse this skill for tests.\n"
  );
  writeFileSync(join(repoRoot, "guruharness.config.json"), JSON.stringify(createHealthyConfig()));
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });

  return repoRoot;
}

function createHealthyConfig() {
  return {
    skillDirectories: ["skills"],
    validationCommands: [
      { name: "test", command: ["npm", "test"], required: true },
      { name: "typecheck", command: ["npm", "run", "typecheck"], required: true },
      { name: "build", command: ["npm", "run", "build"], required: true },
      { name: "repo-hygiene", command: ["pwsh", "-File", "scripts/verify-repo.ps1"], required: true }
    ],
    reviewGate: { provider: "native-critic-panel", required: true },
    approvalPolicy: { autoCommitPushPr: true, allowLocalMerge: false, allowForcePush: false },
    selfBuild: {
      completedTaskIds: [
        "capture-operating-contract",
        "core-result-contracts",
        "supabase-operational-store",
        "self-build-loop",
        "config-loader",
        "tool-registry",
        "repo-context-layer",
        "review-gates",
        "git-pr-automation",
        "maintenance-loop"
      ]
    }
  };
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-maintenance-"));
  tempDirectories.push(directory);

  return directory;
}
