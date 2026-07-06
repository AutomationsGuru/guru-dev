import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadHarnessConfig } from "../config/loadConfig.js";
import type { HarnessConfig } from "../config/schema.js";
import { createDirectionAlignmentReport } from "../direction/hereThere.js";
import { discoverSkills } from "../skills/loader.js";
import { applySelfBuildProgress, createSelfBuildState, planNextSelfBuildTask } from "../kernel/selfBuildLoop.js";
import { resolveRepositoryContext, type RepositoryContext } from "../repo/context.js";

export type MaintenanceAuditVerdict = "GREEN" | "YELLOW" | "RED";
export type MaintenanceCheckStatus = "passed" | "warning" | "failed";

export interface MaintenanceCheck {
  readonly id: string;
  readonly title: string;
  readonly status: MaintenanceCheckStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface MaintenanceAuditReport {
  readonly verdict: MaintenanceAuditVerdict;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly checks: readonly MaintenanceCheck[];
  readonly summary: string;
}

export interface RunMaintenanceAuditOptions {
  readonly repoRoot?: string;
  readonly targetPath?: string;
  readonly configPath?: string;
  readonly cwd?: string;
}

export function runMaintenanceAudit(options: RunMaintenanceAuditOptions = {}): MaintenanceAuditReport {
  const startedAtDate = new Date();
  const cwd = options.cwd ?? process.cwd();
  const repoContext = resolveRepositoryContext({
    ...(options.repoRoot ? { rootPath: options.repoRoot } : {}),
    ...(options.targetPath ? { targetPath: options.targetPath } : {}),
    cwd
  });
  const configResult = loadHarnessConfig({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    cwd: repoContext.repoRoot
  });
  const checks = createMaintenanceChecks(repoContext, configResult.config, configResult.verdict);

  return buildReport(startedAtDate, checks);
}

export function createMaintenanceChecks(
  repoContext: RepositoryContext,
  config: HarnessConfig,
  configVerdict: MaintenanceAuditVerdict
): readonly MaintenanceCheck[] {
  return [
    checkRepoContext(repoContext),
    checkConfig(configVerdict),
    checkValidationCommands(config),
    checkReviewGate(config),
    checkApprovalPolicy(config),
    checkSelfBuildProgress(config),
    checkDirectionAlignment(config),
    checkSkillCatalog(repoContext.repoRoot, config),
    checkDocumentation(repoContext.repoRoot)
  ];
}

function checkRepoContext(repoContext: RepositoryContext): MaintenanceCheck {
  return {
    id: "repo-context",
    title: "Repository context",
    status: repoContext.agentsChain.length > 0 ? "passed" : "failed",
    summary:
      repoContext.agentsChain.length > 0
        ? `Resolved repo with ${repoContext.agentsChain.length} AGENTS.md file(s).`
        : "Repository resolved but no AGENTS.md contract files were found.",
    evidence: [repoContext.repoRoot, ...repoContext.agentsChain.map((agentsFile) => agentsFile.relativePath)]
  };
}

function checkConfig(configVerdict: MaintenanceAuditVerdict): MaintenanceCheck {
  return {
    id: "config-health",
    title: "Config health",
    status: configVerdict === "GREEN" ? "passed" : configVerdict === "YELLOW" ? "warning" : "failed",
    summary: `Config loader verdict is ${configVerdict}.`,
    evidence: [configVerdict]
  };
}

function checkValidationCommands(config: HarnessConfig): MaintenanceCheck {
  const configuredNames = new Set(config.validationCommands.map((command) => command.name));
  const requiredNames = ["test", "typecheck", "build", "repo-hygiene"];
  const missingNames = requiredNames.filter((name) => !configuredNames.has(name));

  return {
    id: "validation-commands",
    title: "Validation commands",
    status: missingNames.length === 0 ? "passed" : "warning",
    summary:
      missingNames.length === 0
        ? "All baseline validation commands are configured."
        : `Missing validation command(s): ${missingNames.join(", ")}.`,
    evidence: [...configuredNames].sort()
  };
}

function checkReviewGate(config: HarnessConfig): MaintenanceCheck {
  // A required review gate is configured — guru's own native panel or an external CLI.
  const passed = config.reviewGate.required;

  return {
    id: "review-gate",
    title: "Review gate",
    status: passed ? "passed" : "failed",
    summary: passed ? "Required CodeRabbit review gate is configured." : "Required CodeRabbit review gate is not configured.",
    evidence: [config.reviewGate.provider, config.reviewGate.required ? "required" : "optional"]
  };
}

function checkApprovalPolicy(config: HarnessConfig): MaintenanceCheck {
  const safePolicy =
    config.approvalPolicy.autoCommitPushPr && !config.approvalPolicy.allowLocalMerge && !config.approvalPolicy.allowForcePush;

  return {
    id: "approval-policy",
    title: "Approval policy",
    status: safePolicy ? "passed" : "failed",
    summary: safePolicy
      ? "Automatic PR workflow is enabled while local merge and force-push remain disabled."
      : "Approval policy is unsafe or incomplete.",
    evidence: [
      `autoCommitPushPr=${config.approvalPolicy.autoCommitPushPr}`,
      `allowLocalMerge=${config.approvalPolicy.allowLocalMerge}`,
      `allowForcePush=${config.approvalPolicy.allowForcePush}`
    ]
  };
}

function checkSelfBuildProgress(config: HarnessConfig): MaintenanceCheck {
  const state = applySelfBuildProgress(createSelfBuildState(), config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);
  const allTasksComplete = state.tasks.every((task) => task.status === "done");

  if (nextTask) {
    return {
      id: "self-build-progress",
      title: "Self-build progress",
      status: "passed",
      summary: `Next self-build task is ${nextTask.id}.`,
      evidence: [nextTask.id]
    };
  }

  return {
    id: "self-build-progress",
    title: "Self-build progress",
    status: allTasksComplete ? "passed" : "warning",
    summary: allTasksComplete ? "All self-build tasks are complete." : "No ready self-build task is configured.",
    evidence: [allTasksComplete ? "all-tasks-complete" : "no-ready-task"]
  };
}

function checkDirectionAlignment(config: HarnessConfig): MaintenanceCheck {
  const state = applySelfBuildProgress(createSelfBuildState(), config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);
  const direction = createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) });

  return {
    id: "direction-alignment",
    title: "HERE/THERE direction alignment",
    status: direction.verdict === "GREEN" ? "passed" : direction.verdict === "YELLOW" ? "warning" : "failed",
    summary: nextTask
      ? `${direction.summary} Next task ${nextTask.id} declares movement toward THERE.`
      : `${direction.summary} No next task is currently selected.`,
    evidence: [
      `HERE=${state.here}`,
      `THERE=${state.there}`,
      ...(nextTask ? [`nextTask=${nextTask.id}`, `thereContribution=${nextTask.thereContribution}`] : []),
      ...direction.checks.map((check) => `${check.id}:${check.status}`)
    ]
  };
}

function checkSkillCatalog(repoRoot: string, config: HarnessConfig): MaintenanceCheck {
  if (config.skillDirectories.length === 0) {
    return {
      id: "skill-catalog",
      title: "Skill catalog",
      status: "warning",
      summary: "No runtime skill directories are configured.",
      evidence: []
    };
  }

  try {
    const catalog = discoverSkills({ directories: config.skillDirectories, cwd: repoRoot });
    const hasSkills = catalog.skills.length > 0;
    const hasDiagnostics = catalog.diagnostics.length > 0;

    return {
      id: "skill-catalog",
      title: "Skill catalog",
      status: hasSkills && !hasDiagnostics ? "passed" : "warning",
      summary: hasSkills
        ? `Discovered ${catalog.skills.length} runtime skill(s)${hasDiagnostics ? " with diagnostics." : "."}`
        : "Runtime skill directories are configured but no skills were discovered.",
      evidence: [...catalog.directories, ...catalog.skills.map((skill) => skill.id), ...catalog.diagnostics]
    };
  } catch (error) {
    return {
      id: "skill-catalog",
      title: "Skill catalog",
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      evidence: config.skillDirectories
    };
  }
}

function checkDocumentation(repoRoot: string): MaintenanceCheck {
  const requiredPaths = ["AGENTS.md", "README.md", "docs/coordination/current-state.md", "docs/decisions"];
  const missingPaths = requiredPaths.filter((path) => !existsSync(join(repoRoot, path)));

  return {
    id: "documentation",
    title: "Documentation surfaces",
    status: missingPaths.length === 0 ? "passed" : "failed",
    summary: missingPaths.length === 0 ? "Required documentation surfaces exist." : `Missing docs: ${missingPaths.join(", ")}.`,
    evidence: missingPaths.length === 0 ? requiredPaths : missingPaths
  };
}

function buildReport(startedAtDate: Date, checks: readonly MaintenanceCheck[]): MaintenanceAuditReport {
  const endedAtDate = new Date();
  const verdict = deriveVerdict(checks);

  return {
    verdict,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: Math.max(0, endedAtDate.getTime() - startedAtDate.getTime()),
    checks,
    summary: `${verdict}: ${checks.filter((check) => check.status === "passed").length}/${checks.length} maintenance check(s) passed.`
  };
}

function deriveVerdict(checks: readonly MaintenanceCheck[]): MaintenanceAuditVerdict {
  if (checks.some((check) => check.status === "failed")) {
    return "RED";
  }

  if (checks.some((check) => check.status === "warning")) {
    return "YELLOW";
  }

  return "GREEN";
}
