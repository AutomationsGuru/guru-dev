import { executeCommand, type CommandExecutor, type CommandExecutionResult } from "../review/gates.js";
import type { AgentCommitConfig } from "./agentCommitConfig.js";

export type AgentCommitVerdict = "GREEN" | "RED";
export type AgentCommitStepName = "dirty-snapshot" | "ai-edit" | "undo";
export type AgentCommitStepStatus = "planned" | "passed" | "failed" | "skipped";

export interface AgentCommitStep {
  readonly name: AgentCommitStepName;
  readonly command: readonly string[];
}

export interface AgentCommitStepResult extends AgentCommitStep {
  readonly status: AgentCommitStepStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly summary: string;
}

export interface AgentCommitReport {
  readonly verdict: AgentCommitVerdict;
  readonly dryRun: boolean;
  readonly steps: readonly AgentCommitStepResult[];
  readonly summary: string;
}

export interface AgentCommitOptions {
  readonly config: AgentCommitConfig;
  readonly repoRoot: string;
  readonly modelName: string;
  readonly modelRole: string;
  readonly executor?: CommandExecutor;
}

export interface CommitSnapshotRequest {
  readonly repoRoot: string;
  readonly message: string;
}

export interface CommitAiEditRequest {
  readonly repoRoot: string;
  readonly message: string;
  readonly modelName: string;
  readonly modelRole: string;
}

export interface UndoLastAgentCommitRequest {
  readonly repoRoot: string;
}

const AI_COMMIT_TRAILER = "AI-commit: true";

const PROTECTED_BRANCHES = new Set(["main", "master", "trunk"]);

function isAgentCommitTrailer(line: string): boolean {
  return line.trim() === AI_COMMIT_TRAILER || line.startsWith("AI-commit: true");
}

function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch) || /^[0-9a-f]+\.\.\.HEAD$/iu.test(branch);
}

function assertAgentCommitsEnabled(config: AgentCommitConfig): void {
  if (!config.agentAutoCommit) {
    throw new Error(
      "agentAutoCommit is disabled. Enable it in config to use agent-authored local commits."
    );
  }
}

function assertLocalSafe(request: { repoRoot: string }, executor: CommandExecutor): Promise<CommandExecutionResult> {
  return executor(["git", "-C", request.repoRoot, "rev-parse", "--abbrev-ref", "@{push}"], {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "git-push-upstream",
      command: ["git", "rev-parse", "--abbrev-ref", "@{push}"],
      required: false
    }
  });
}

function hasPushUpstream(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.trim();
  return text.length > 0 && !text.includes("fatal: ") && !text.includes("error: ");
}

function assertSafeGitArgs(...values: string[]): void {
  for (const value of values) {
    if (value.startsWith("-")) {
      throw new Error(`Refusing unsafe git argument: ${value}`);
    }
  }
}

export function buildSnapshotCommitCommand(
  request: CommitSnapshotRequest
): readonly string[] {
  assertSafeGitArgs(request.repoRoot, request.message);
  return ["git", "-C", request.repoRoot, "commit", "-a", "-m", request.message];
}

export function buildAiEditCommitCommand(
  request: CommitAiEditRequest
): readonly string[] {
  assertSafeGitArgs(request.repoRoot, request.message, request.modelName, request.modelRole);
  return ["git", "-C", request.repoRoot, "commit", "-a", "-m", request.message];
}

export function buildUndoLastAgentCommitCommand(
  request: UndoLastAgentCommitRequest
): readonly string[] {
  assertSafeGitArgs(request.repoRoot);
  return ["git", "-C", request.repoRoot, "reset", "--soft", "HEAD~1"];
}

export function buildGetLastCommitMessageCommand(
  request: { repoRoot: string }
): readonly string[] {
  assertSafeGitArgs(request.repoRoot);
  return ["git", "-C", request.repoRoot, "log", "-1", "--pretty=format:%B"];
}

export function buildGetCurrentBranchCommand(
  request: { repoRoot: string }
): readonly string[] {
  assertSafeGitArgs(request.repoRoot);
  return ["git", "-C", request.repoRoot, "rev-parse", "--abbrev-ref", "HEAD"];
}

function createCommitMessage(baseMessage: string, modelName: string, modelRole: string, includeTrailer: boolean, includeCoAuthor: boolean): string {
  const trailerLines: string[] = [];

  if (includeTrailer) {
    trailerLines.push(AI_COMMIT_TRAILER);
  }

  if (includeCoAuthor) {
    trailerLines.push(`Co-authored-by: ${modelName} <${modelRole}>`);
  }

  if (trailerLines.length === 0) {
    return baseMessage;
  }

  return `${baseMessage}\n\n${trailerLines.join("\n")}`;
}

export async function commitDirtySnapshot(
  request: CommitSnapshotRequest,
  options: Pick<AgentCommitOptions, "config" | "executor"> = {
    config: { agentAutoCommit: false, dirtyFirst: true, includeAttributionTrailer: true, includeCoAuthorTrailer: true }
  }
): Promise<AgentCommitReport> {
  assertAgentCommitsEnabled(options.config);

  const executor = options.executor ?? executeCommand;
  const command = buildSnapshotCommitCommand(request);
  const execution = await executor(command, {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "dirty-snapshot",
      command,
      required: true
    }
  });

  const status: AgentCommitStepStatus = execution.exitCode === 0 ? "passed" : "failed";

  return {
    verdict: status === "passed" ? "GREEN" : "RED",
    dryRun: false,
    steps: [
      {
        name: "dirty-snapshot",
        command,
        status,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
        summary: `${status === "passed" ? "Created" : "Failed to create"} dirty snapshot commit: ${request.message}`
      }
    ],
    summary: status === "passed"
      ? `GREEN: dirty snapshot committed as '${request.message}'.`
      : `RED: dirty snapshot commit failed.`
  };
}

export async function commitAiEdit(
  request: CommitAiEditRequest,
  options: AgentCommitOptions
): Promise<AgentCommitReport> {
  assertAgentCommitsEnabled(options.config);

  const executor = options.executor ?? executeCommand;

  const currentBranch = await executor(buildGetCurrentBranchCommand(request), {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "current-branch",
      command: buildGetCurrentBranchCommand(request),
      required: true
    }
  });

  const branch = currentBranch.stdout.trim();

  if (isProtectedBranch(branch)) {
    throw new Error(`Refusing AI edit commit on protected branch: ${branch}`);
  }

  const pushCheck = await assertLocalSafe(request, executor);
  if (hasPushUpstream(pushCheck.stdout, pushCheck.stderr)) {
    throw new Error(
      "Refusing AI edit commit: the current branch has a configured upstream push. Undo must be local-only."
    );
  }

  const fullMessage = createCommitMessage(
    request.message,
    request.modelName,
    request.modelRole,
    options.config.includeAttributionTrailer,
    options.config.includeCoAuthorTrailer
  );

  const command = buildAiEditCommitCommand({ repoRoot: request.repoRoot, message: fullMessage, modelName: request.modelName, modelRole: request.modelRole });
  const execution = await executor(command, {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "ai-edit",
      command,
      required: true
    }
  });

  const status: AgentCommitStepStatus = execution.exitCode === 0 ? "passed" : "failed";

  return {
    verdict: status === "passed" ? "GREEN" : "RED",
    dryRun: false,
    steps: [
      {
        name: "ai-edit",
        command,
        status,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
        summary: `${status === "passed" ? "Created" : "Failed to create"} AI edit commit: ${request.message}`
      }
    ],
    summary: status === "passed"
      ? `GREEN: AI edit committed as '${request.message}'.`
      : `RED: AI edit commit failed.`
  };
}

export async function undoLastAgentCommit(
  request: UndoLastAgentCommitCommitRequest,
  options: Pick<AgentCommitOptions, "config" | "executor"> = {
    config: { agentAutoCommit: false, dirtyFirst: true, includeAttributionTrailer: true, includeCoAuthorTrailer: true }
  }
): Promise<AgentCommitReport> {
  assertAgentCommitsEnabled(options.config);

  const executor = options.executor ?? executeCommand;

  const currentBranch = await executor(buildGetCurrentBranchCommand(request), {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "current-branch",
      command: buildGetCurrentBranchCommand(request),
      required: true
    }
  });

  const branch = currentBranch.stdout.trim();

  if (isProtectedBranch(branch)) {
    throw new Error(`Refusing undo on protected branch: ${branch}`);
  }

  const pushCheck = await assertLocalSafe(request, executor);
  if (hasPushUpstream(pushCheck.stdout, pushCheck.stderr)) {
    throw new Error(
      "Refusing undo: the current branch has a configured upstream push. Undo must be local-only."
    );
  }

  const logCommand = buildGetLastCommitMessageCommand(request);
  const logResult = await executor(logCommand, {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "last-commit-message",
      command: logCommand,
      required: true
    }
  });

  if (logResult.exitCode !== 0) {
    return {
      verdict: "RED",
      dryRun: false,
      steps: [
        {
          name: "undo",
          command: logCommand,
          status: "failed",
          exitCode: logResult.exitCode,
          stdout: logResult.stdout,
          stderr: logResult.stderr,
          durationMs: logResult.durationMs,
          summary: "Failed to read the last commit message before undo."
        }
      ],
      summary: "RED: could not verify the last commit before undo."
    };
  }

  const lastMessage = logResult.stdout;
  const hasAttribution = lastMessage.split(/\r?\n/).some(isAgentCommitTrailer);

  if (!hasAttribution) {
    return {
      verdict: "RED",
      dryRun: false,
      steps: [
        {
          name: "undo",
          command: logCommand,
          status: "failed",
          exitCode: 0,
          stdout: lastMessage,
          stderr: "Last commit lacks the AI-commit attribution trailer; undo refuses to touch non-agent commits.",
          durationMs: logResult.durationMs,
          summary: "Undo refused: the last commit does not have an AI-commit attribution trailer."
        }
      ],
      summary: "RED: undo refused because the last commit is not marked as an agent commit."
    };
  }

  const command = buildUndoLastAgentCommitCommand(request);
  const execution = await executor(command, {
    cwd: request.repoRoot,
    gate: {
      kind: "validation",
      name: "undo",
      command,
      required: true
    }
  });

  const status: AgentCommitStepStatus = execution.exitCode === 0 ? "passed" : "failed";

  return {
    verdict: status === "passed" ? "GREEN" : "RED",
    dryRun: false,
    steps: [
      {
        name: "undo",
        command,
        status,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
        summary: status === "passed" ? "Undid the last agent commit." : "Failed to undo the last agent commit."
      }
    ],
    summary: status === "passed"
      ? "GREEN: last agent commit undone (soft reset to HEAD~1)."
      : "RED: undo command failed."
  };
}

// Exported interface alias for callers who need the request shape.
export interface UndoLastAgentCommitCommitRequest {
  readonly repoRoot: string;
}

export interface RunAgentCommitRequest {
  readonly repoRoot: string;
  readonly message: string;
  readonly modelName: string;
  readonly modelRole: string;
  readonly dirtyFirst?: boolean;
}

export interface RunAgentCommitOptions extends AgentCommitOptions {}

export async function runAgentCommit(
  request: RunAgentCommitRequest,
  options: RunAgentCommitOptions
): Promise<AgentCommitReport> {
  assertAgentCommitsEnabled(options.config);

  const shouldSnapshot = (request.dirtyFirst ?? options.config.dirtyFirst);
  const steps: AgentCommitStepResult[] = [];

  if (shouldSnapshot) {
    const snapshotMessage = `snapshot: pre-ai state`;
    const snapshot = await commitDirtySnapshot({ repoRoot: request.repoRoot, message: snapshotMessage }, options);
    steps.push(...snapshot.steps);

    if (snapshot.verdict === "RED") {
      return {
        verdict: "RED",
        dryRun: false,
        steps,
        summary: "RED: dirty snapshot failed before AI edit commit could run."
      };
    }
  }

  const aiEdit = await commitAiEdit(
    {
      repoRoot: request.repoRoot,
      message: request.message,
      modelName: request.modelName,
      modelRole: request.modelRole
    },
    options
  );
  steps.push(...aiEdit.steps);

  return {
    verdict: aiEdit.verdict,
    dryRun: false,
    steps,
    summary: aiEdit.verdict === "GREEN"
      ? `GREEN: agent commit protocol completed (${steps.length} step(s)).`
      : `RED: agent commit protocol failed after ${steps.length} step(s).`
  };
}

export function createSnapshotMessage(providerName?: string): string {
  return providerName ? `snapshot: pre-ai state (${providerName})` : "snapshot: pre-ai state";
}

export function createConventionalAiEditMessage(type: string, description: string): string {
  return `${type}: ${description}`;
}

export const AI_COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore"] as const;
export type AiCommitType = (typeof AI_COMMIT_TYPES)[number];

export function createWeakModelAiEditMessage(
  type: AiCommitType,
  summary: string,
  _changes: readonly string[]
): string {
  return `${type}: ${summary}`;
}

export function isAgentCommitAllowed(config: AgentCommitConfig): boolean {
  return config.agentAutoCommit;
}

export function isAgentCommitMessage(message: string): boolean {
  return message.split(/\r?\n/).some(isAgentCommitTrailer);
}

export function isPushRiskKnown(stdout: string, stderr: string): boolean {
  return hasPushUpstream(stdout, stderr);
}

export function isBranchProtected(branch: string): boolean {
  return isProtectedBranch(branch);
}
