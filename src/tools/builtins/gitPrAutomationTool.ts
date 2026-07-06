import { z } from "zod";

import { runGitPrAutomation, type GitPrAutomationReport, type GitPrAutomationRequest } from "../../git/prAutomation.js";
import type { CommandExecutor } from "../../review/gates.js";
import type { ToolDefinition } from "../registry.js";

const GitPrAutomationVerdictSchema = z.enum(["GREEN", "RED"]);
const GitPrAutomationStepStatusSchema = z.enum(["planned", "passed", "failed"]);

const GitPrAutomationStepResultSchema = z.object({
  name: z.string(),
  command: z.array(z.string()),
  status: GitPrAutomationStepStatusSchema,
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  summary: z.string()
});

export const GitPrAutomationToolInputSchema = z.object({
  repoRoot: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1),
  branchName: z.string().trim().min(1),
  commitMessage: z.string().trim().min(1),
  prTitle: z.string().trim().min(1),
  prBody: z.string().trim().min(1),
  paths: z.array(z.string().trim().min(1)).default(["."]),
  remote: z.string().trim().min(1).default("origin"),
  draft: z.boolean().default(false),
  dryRun: z.boolean().default(true)
});

export const GitPrAutomationToolOutputSchema = z.object({
  verdict: GitPrAutomationVerdictSchema,
  dryRun: z.boolean(),
  steps: z.array(GitPrAutomationStepResultSchema),
  summary: z.string()
});

export type GitPrAutomationToolInput = z.infer<typeof GitPrAutomationToolInputSchema>;
export type GitPrAutomationToolOutput = z.infer<typeof GitPrAutomationToolOutputSchema>;

export function createGitPrAutomationTool(
  executor?: CommandExecutor
): ToolDefinition<typeof GitPrAutomationToolInputSchema, typeof GitPrAutomationToolOutputSchema> {
  return {
    id: "git.pr.run",
    title: "Run git and PR automation",
    description: "Plan or run git add/commit/push and GitHub PR creation without force-push or local merge operations.",
    inputSchema: GitPrAutomationToolInputSchema,
    outputSchema: GitPrAutomationToolOutputSchema,
    execute(input) {
      const request: GitPrAutomationRequest = {
        repoRoot: input.repoRoot,
        baseBranch: input.baseBranch,
        branchName: input.branchName,
        commitMessage: input.commitMessage,
        prTitle: input.prTitle,
        prBody: input.prBody,
        paths: input.paths,
        remote: input.remote,
        draft: input.draft,
        dryRun: input.dryRun
      };

      return runGitPrAutomation(request, executor ? { executor } : {}).then(materializeReport);
    }
  };
}

function materializeReport(report: GitPrAutomationReport): GitPrAutomationToolOutput {
  return {
    ...report,
    steps: report.steps.map((step) => ({
      ...step,
      command: [...step.command]
    }))
  };
}
