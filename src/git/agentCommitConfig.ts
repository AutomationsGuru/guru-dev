import { z } from "zod";

/**
 * Runtime policy for opt-in agent-authored local git commits.
 *
 * This is intentionally **not** part of the approval/PR automation path:
 * it is a local-only, default-off protocol for an operator who wants the
 * harness to snapshot its own work (e.g. before/after an AI edit) without
 * ever pushing, force-pushing, amending, or touching non-agent commits.
 */
export const AgentCommitConfigSchema = z
  .object({
    /** Master switch: agent-authored local commits are default OFF. */
    agentAutoCommit: z.boolean().default(false),
    /** When true and the tree is dirty before an AI write, snapshot the dirty tree first. */
    dirtyFirst: z.boolean().default(true),
    /** When true, add an `AI-commit: true` git-trailer to the AI edit commit. */
    includeAttributionTrailer: z.boolean().default(true),
    /** When true, include the model name/role in the `Co-authored-by:` trailer. */
    includeCoAuthorTrailer: z.boolean().default(true)
  })
  .strict();

export type AgentCommitConfig = z.infer<typeof AgentCommitConfigSchema>;

export const DEFAULT_AGENT_COMMIT_CONFIG: AgentCommitConfig = AgentCommitConfigSchema.parse({
  agentAutoCommit: false,
  dirtyFirst: true,
  includeAttributionTrailer: true,
  includeCoAuthorTrailer: true
});

/** Convenience guard: aborts with a clear message when the master switch is off. */
export function assertAgentCommitsEnabled(config: AgentCommitConfig): void {
  if (!config.agentAutoCommit) {
    throw new Error(
      "agentAutoCommit is disabled. Enable it in config to use agent-authored local commits."
    );
  }
}
