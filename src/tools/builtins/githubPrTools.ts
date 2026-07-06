import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { executeCommand, type CommandExecutionResult, type CommandExecutor } from "../../review/gates.js";
import { guardContent, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

const GitHubRepoSchema = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const PrNumberSchema = z.number().int().positive();
const RedactedCommandSchema = z.array(z.string());
const GitHubCommandOutputSchema = z
  .object({
    executed: z.boolean(),
    dryRun: z.boolean(),
    command: RedactedCommandSchema,
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export const GitHubPrStatusToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    prNumber: PrNumberSchema.optional(),
    repo: GitHubRepoSchema.optional(),
    dryRun: z.boolean().default(false)
  })
  .strict();

export const GitHubPrStatusToolOutputSchema = GitHubCommandOutputSchema;

export const GitHubPrCommentToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    prNumber: PrNumberSchema,
    repo: GitHubRepoSchema.optional(),
    body: z.string().trim().min(1),
    dryRun: z.boolean().default(true)
  })
  .strict();

export const GitHubPrCommentToolOutputSchema = GitHubCommandOutputSchema.extend({
  bodyBytes: z.number().int().nonnegative()
}).strict();

export const GitHubPrReviewToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    prNumber: PrNumberSchema.optional(),
    repo: GitHubRepoSchema.optional(),
    action: z.enum(["approve", "request-changes", "comment"]),
    body: z.string().trim().min(1).optional(),
    dryRun: z.boolean().default(true)
  })
  .strict();

export const GitHubPrReviewToolOutputSchema = GitHubCommandOutputSchema.extend({
  bodyBytes: z.number().int().nonnegative().optional()
}).strict();

export type GitHubPrStatusToolInput = z.infer<typeof GitHubPrStatusToolInputSchema>;
export type GitHubPrStatusToolOutput = z.infer<typeof GitHubPrStatusToolOutputSchema>;
export type GitHubPrCommentToolInput = z.infer<typeof GitHubPrCommentToolInputSchema>;
export type GitHubPrCommentToolOutput = z.infer<typeof GitHubPrCommentToolOutputSchema>;
export type GitHubPrReviewToolInput = z.infer<typeof GitHubPrReviewToolInputSchema>;
export type GitHubPrReviewToolOutput = z.infer<typeof GitHubPrReviewToolOutputSchema>;

export interface GitHubPrToolOptions {
  readonly executor?: CommandExecutor;
  readonly secretAllowList?: readonly string[];
}

export function createGitHubPrStatusTool(
  options: GitHubPrToolOptions = {}
): ToolDefinition<typeof GitHubPrStatusToolInputSchema, typeof GitHubPrStatusToolOutputSchema> {
  const executor = options.executor ?? executeCommand;

  return {
    id: "github.pr.status",
    title: "Read GitHub PR status",
    description: "Read PR state, checks, review decision, and branch metadata through the GitHub CLI. This helper is read-only.",
    inputSchema: GitHubPrStatusToolInputSchema,
    outputSchema: GitHubPrStatusToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const command = buildPrStatusCommand(input);
      const blockers = buildCommonBlockers(repoRoot);

      if (blockers.length > 0 || input.dryRun) {
        return plannedOutput(command, input.dryRun, blockers, blockers.length > 0 ? "GitHub PR status blocked by policy." : "Dry run only; status command was not executed.");
      }

      return executeGithubCommand(command, repoRoot, executor, "github.pr.status");
    }
  };
}

export function createGitHubPrCommentTool(
  options: GitHubPrToolOptions = {}
): ToolDefinition<typeof GitHubPrCommentToolInputSchema, typeof GitHubPrCommentToolOutputSchema> {
  const executor = options.executor ?? executeCommand;

  return {
    id: "github.pr.comment",
    title: "Comment on GitHub PR",
    description: "Post a PR comment through gh with dry-run by default and secret redaction checks.",
    inputSchema: GitHubPrCommentToolInputSchema,
    outputSchema: GitHubPrCommentToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const command = buildPrCommentCommand(input);
      const blockers = [...buildCommonBlockers(repoRoot), ...buildBodyBlockers(repoRoot, input.body, options.secretAllowList ?? [])];
      const bodyBytes = Buffer.byteLength(input.body, "utf8");

      if (blockers.length > 0 || input.dryRun) {
        return {
          ...plannedOutput(redactBodyArgument(command), input.dryRun, blockers, blockers.length > 0 ? "GitHub PR comment blocked by policy." : "Dry run only; PR comment was not posted."),
          bodyBytes
        };
      }

      return { ...(await executeGithubCommand(command, repoRoot, executor, "github.pr.comment", true)), bodyBytes };
    }
  };
}

export function createGitHubPrReviewTool(
  options: GitHubPrToolOptions = {}
): ToolDefinition<typeof GitHubPrReviewToolInputSchema, typeof GitHubPrReviewToolOutputSchema> {
  const executor = options.executor ?? executeCommand;

  return {
    id: "github.pr.review",
    title: "Review GitHub PR",
    description: "Submit an approve, request-changes, or comment review through gh with dry-run by default and secret redaction checks.",
    inputSchema: GitHubPrReviewToolInputSchema,
    outputSchema: GitHubPrReviewToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const body = input.body ?? "";
      const command = buildPrReviewCommand(input);
      const blockers = [
        ...buildCommonBlockers(repoRoot),
        ...buildReviewBodyBlockers(input),
        ...buildBodyBlockers(repoRoot, body, options.secretAllowList ?? [])
      ];
      const bodyBytes = input.body ? Buffer.byteLength(input.body, "utf8") : undefined;

      if (blockers.length > 0 || input.dryRun) {
        return {
          ...plannedOutput(redactBodyArgument(command), input.dryRun, blockers, blockers.length > 0 ? "GitHub PR review blocked by policy." : "Dry run only; PR review was not submitted."),
          ...(bodyBytes === undefined ? {} : { bodyBytes })
        };
      }

      return {
        ...(await executeGithubCommand(command, repoRoot, executor, "github.pr.review", true)),
        ...(bodyBytes === undefined ? {} : { bodyBytes })
      };
    }
  };
}

function buildPrStatusCommand(input: GitHubPrStatusToolInput): string[] {
  const command = [
    "gh",
    "pr",
    "view",
    ...(input.prNumber ? [String(input.prNumber)] : []),
    "--json",
    "number,title,state,url,headRefName,baseRefName,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup"
  ];

  return appendRepo(command, input.repo);
}

function buildPrCommentCommand(input: GitHubPrCommentToolInput): string[] {
  return appendRepo(["gh", "pr", "comment", String(input.prNumber), "--body", input.body], input.repo);
}

function buildPrReviewCommand(input: GitHubPrReviewToolInput): string[] {
  const actionFlag = input.action === "approve" ? "--approve" : input.action === "request-changes" ? "--request-changes" : "--comment";
  const command = ["gh", "pr", "review", ...(input.prNumber ? [String(input.prNumber)] : []), actionFlag];

  if (input.body) {
    command.push("--body", input.body);
  }

  return appendRepo(command, input.repo);
}

function appendRepo(command: string[], repo: string | undefined): string[] {
  return repo ? [...command, "--repo", repo] : command;
}

function buildCommonBlockers(repoRoot: string): string[] {
  const relativeRoot = relative(resolve(repoRoot), repoRoot);

  return relativeRoot.startsWith("..") || isAbsolute(relativeRoot) ? ["Repository root is invalid (path redacted)."] : [];
}

function buildReviewBodyBlockers(input: GitHubPrReviewToolInput): string[] {
  if ((input.action === "comment" || input.action === "request-changes") && !input.body) {
    return [`Review action ${input.action} requires a body.`];
  }

  return [];
}

function buildBodyBlockers(repoRoot: string, body: string, secretAllowList: readonly string[]): string[] {
  if (!body) {
    return [];
  }

  const policy: ToolPolicy = {
    repoRoot,
    riskyPathPatterns: [],
    secretAllowList,
    allowRiskyPaths: false
  };

  return [...guardContent([{ name: "body", value: body }], policy).blockers];
}

function plannedOutput(command: readonly string[], dryRun: boolean, blockers: readonly string[], summary: string): GitHubPrStatusToolOutput {
  return {
    executed: false,
    dryRun,
    command: [...command],
    blockers: [...blockers],
    summary
  };
}

async function executeGithubCommand(
  command: readonly string[],
  repoRoot: string,
  executor: CommandExecutor,
  gateName: string,
  redactBody = false
): Promise<GitHubPrStatusToolOutput> {
  const result = await executor(command, {
    cwd: repoRoot,
    gate: {
      kind: "review",
      name: gateName,
      command,
      required: true
    }
  });

  return materializeExecution(redactBody ? redactBodyArgument(command) : command, result);
}

function materializeExecution(command: readonly string[], result: CommandExecutionResult): GitHubPrStatusToolOutput {
  return {
    executed: true,
    dryRun: false,
    command: [...command],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    blockers: [],
    summary: result.exitCode === 0 ? "GitHub CLI command completed successfully." : "GitHub CLI command completed with a non-zero or null exit code."
  };
}

function redactBodyArgument(command: readonly string[]): string[] {
  return command.map((part, index) => (index > 0 && command[index - 1] === "--body" ? "[redacted]" : part));
}
