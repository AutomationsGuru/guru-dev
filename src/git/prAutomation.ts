import { executeCommand, type CommandExecutionResult, type CommandExecutor } from "../review/gates.js";

export type GitPrAutomationVerdict = "GREEN" | "RED";
export type GitPrAutomationStepStatus = "planned" | "passed" | "failed";

export interface GitPrAutomationRequest {
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly branchName: string;
  readonly commitMessage: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly paths: readonly string[];
  readonly remote?: string;
  readonly draft?: boolean;
  readonly dryRun?: boolean;
}

export interface GitPrAutomationStep {
  readonly name: string;
  readonly command: readonly string[];
}

export interface GitPrAutomationStepResult extends GitPrAutomationStep {
  readonly status: GitPrAutomationStepStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly summary: string;
}

export interface GitPrAutomationReport {
  readonly verdict: GitPrAutomationVerdict;
  readonly dryRun: boolean;
  readonly steps: readonly GitPrAutomationStepResult[];
  readonly summary: string;
}

export interface RunGitPrAutomationOptions {
  readonly executor?: CommandExecutor;
}

export function createGitPrAutomationPlan(request: GitPrAutomationRequest): readonly GitPrAutomationStep[] {
  assertSafeGitPrRequest(request);

  const remote = request.remote ?? "origin";
  const paths = request.paths.length > 0 ? request.paths : ["."];

  return [
    { name: "git-status", command: ["git", "-C", request.repoRoot, "status", "--short", "--branch"] },
    { name: "git-add", command: ["git", "-C", request.repoRoot, "add", "--", ...paths] },
    { name: "git-commit", command: ["git", "-C", request.repoRoot, "commit", "-m", request.commitMessage] },
    { name: "git-push", command: ["git", "-C", request.repoRoot, "push", "-u", remote, request.branchName] },
    {
      name: "gh-pr-create",
      command: [
        "gh",
        "pr",
        "create",
        "--base",
        request.baseBranch,
        "--head",
        request.branchName,
        "--title",
        request.prTitle,
        "--body",
        request.prBody,
        ...(request.draft ? ["--draft"] : [])
      ]
    }
  ];
}

export async function runGitPrAutomation(
  request: GitPrAutomationRequest,
  options: RunGitPrAutomationOptions = {}
): Promise<GitPrAutomationReport> {
  const dryRun = request.dryRun ?? true;
  const plan = createGitPrAutomationPlan(request);

  if (dryRun) {
    return {
      verdict: "GREEN",
      dryRun,
      steps: plan.map((step) => createPlannedStepResult(step)),
      summary: `GREEN: ${plan.length} git/PR automation step(s) planned.`
    };
  }

  const executor = options.executor ?? executeCommand;
  const results: GitPrAutomationStepResult[] = [];

  for (const step of plan) {
    const execution = await executeStep(step, request.repoRoot, executor);
    const result = toStepResult(step, execution);
    results.push(result);

    if (result.status === "failed") {
      return {
        verdict: "RED",
        dryRun,
        steps: results,
        summary: `RED: ${step.name} failed; git/PR automation stopped.`
      };
    }
  }

  return {
    verdict: "GREEN",
    dryRun,
    steps: results,
    summary: `GREEN: ${results.length} git/PR automation step(s) passed.`
  };
}

function assertSafeGitPrRequest(request: GitPrAutomationRequest): void {
  const unsafeBranchNames = new Set(["main", "master"]);

  assertNonEmpty("repoRoot", request.repoRoot);
  assertNonEmpty("baseBranch", request.baseBranch);
  assertNonEmpty("branchName", request.branchName);
  assertNonEmpty("commitMessage", request.commitMessage);
  assertNonEmpty("prTitle", request.prTitle);
  assertNonEmpty("prBody", request.prBody);

  if (unsafeBranchNames.has(request.branchName)) {
    throw new Error(`Refusing to automate directly on protected branch: ${request.branchName}`);
  }

  for (const value of [request.baseBranch, request.branchName, request.remote ?? "origin", ...request.paths]) {
    if (value.startsWith("-")) {
      throw new Error(`Refusing unsafe git argument: ${value}`);
    }
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
}

async function executeStep(
  step: GitPrAutomationStep,
  repoRoot: string,
  executor: CommandExecutor
): Promise<CommandExecutionResult> {
  return executor(step.command, {
    cwd: repoRoot,
    gate: {
      kind: "validation",
      name: step.name,
      command: step.command,
      required: true
    }
  });
}

function toStepResult(step: GitPrAutomationStep, execution: CommandExecutionResult): GitPrAutomationStepResult {
  const status: GitPrAutomationStepStatus = execution.exitCode === 0 ? "passed" : "failed";

  return {
    ...step,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    durationMs: execution.durationMs,
    status,
    summary: `${step.name} ${status}.`
  };
}

function createPlannedStepResult(step: GitPrAutomationStep): GitPrAutomationStepResult {
  return {
    ...step,
    status: "planned",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    summary: `${step.name} planned.`
  };
}
