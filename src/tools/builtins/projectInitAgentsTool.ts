import { z } from "zod";

import type { ToolDefinition } from "../registry.js";
import { ProjectInitAgentsResultSchema, proposeAgentsMd } from "../projectInit/proposeAgentsMd.js";

export const ProjectInitAgentsToolInputSchema = z.object({
  repoRoot: z.string().trim().min(1).optional().describe("Repository root to scan; defaults to the current working directory."),
  targetPath: z.string().trim().min(1).optional().describe("Target path within the repo for AGENTS.md chain resolution."),
  /**
   * Default false. When false, the tool only proposes a draft and reports whether
   * an AGENTS.md already exists. True requires explicit operator action and backup.
   */
  apply: z.boolean().default(false).describe("When true, request write; never write without force when AGENTS.md exists."),
  /**
   * Required when apply=true and AGENTS.md already exists. The operator must
   * explicitly back up the existing file and set force=true to overwrite.
   */
  force: z.boolean().default(false).describe("Explicitly allow overwriting an existing AGENTS.md; requires prior backup."),
  dryRun: z.boolean().default(true).describe("When true, no file is written. The default is propose-only.")
}).strict();

export const ProjectInitAgentsToolOutputSchema = ProjectInitAgentsResultSchema.extend({
  /** Whether a write would be blocked by existing AGENTS.md without force. */
  blocked: z.boolean(),
  /** Reasoning for the proposal or refusal. */
  reason: z.string()
});

export type ProjectInitAgentsToolInput = z.infer<typeof ProjectInitAgentsToolInputSchema>;
export type ProjectInitAgentsToolOutput = z.infer<typeof ProjectInitAgentsToolOutputSchema>;

export function createProjectInitAgentsTool(): ToolDefinition<
  typeof ProjectInitAgentsToolInputSchema,
  typeof ProjectInitAgentsToolOutputSchema
> {
  return {
    id: "project_init_agents",
    title: "Propose project AGENTS.md",
    description:
      "Scan package.json and README, then propose a draft AGENTS.md (DOX stub) for operator review. " +
      "Default behavior is propose-only (dryRun=true). To apply, explicitly set apply=true; " +
      "if AGENTS.md already exists, set force=true only after backing up the existing file.",
    inputSchema: ProjectInitAgentsToolInputSchema,
    outputSchema: ProjectInitAgentsToolOutputSchema,
    effect: "read-only",
    execute(input, context) {
      const repoRoot = input.repoRoot ?? context.cwd ?? process.cwd();
      const proposal = proposeAgentsMd({
        repoRoot,
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
        apply: input.apply,
        force: input.force
      });

      const blocked = proposal.hasExistingRootAgents && input.apply && !input.force;
      const reason = blocked
        ? "Refused: AGENTS.md already exists. Back it up and set force=true to overwrite."
        : proposal.hasExistingRootAgents && input.force
          ? "Clobber requested with force=true; operator must have backed up the existing AGENTS.md before calling."
          : input.apply
            ? "Apply requested; because this tool is proposal-only, no file was written. Use the write tool with overwrite=false or explicit force after backup."
            : "Propose-only mode; review the draft and apply with explicit operator approval + backup.";

      return {
        ...proposal,
        blocked,
        reason
      };
    }
  };
}
