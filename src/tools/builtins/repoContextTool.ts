import { z } from "zod";

import { resolveRepositoryContext } from "../../repo/context.js";
import type { ToolDefinition } from "../registry.js";

const AgentsFileSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  /** Present when includeContents=true (default). Compact mode returns bytes only. */
  contents: z.string().optional(),
  bytes: z.number().int().nonnegative().optional()
});

export const RepoContextToolInputSchema = z.object({
  targetPath: z.string().trim().min(1).optional(),
  rootPath: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  /**
   * When false, AGENTS.md chain entries omit file contents (path + bytes only) —
   * a token-efficient default for model turns; use the read tool for full text.
   */
  includeContents: z.boolean().default(true)
});

export const RepoContextToolOutputSchema = z.object({
  repoRoot: z.string(),
  targetPath: z.string(),
  gitStatus: z.string(),
  agentsChain: z.array(AgentsFileSchema)
});

export type RepoContextToolInput = z.infer<typeof RepoContextToolInputSchema>;
export type RepoContextToolOutput = z.infer<typeof RepoContextToolOutputSchema>;

export function createRepoContextTool(): ToolDefinition<typeof RepoContextToolInputSchema, typeof RepoContextToolOutputSchema> {
  return {
    id: "repo.context.resolve",
    title: "Resolve repository context",
    description: "Resolve git root, git status, and root-to-leaf AGENTS.md chain for a target path.",
    inputSchema: RepoContextToolInputSchema,
    outputSchema: RepoContextToolOutputSchema,
    execute(input) {
      const context = resolveRepositoryContext({
        ...(input.targetPath ? { targetPath: input.targetPath } : {}),
        ...(input.rootPath ? { rootPath: input.rootPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      });

      return {
        ...context,
        agentsChain: context.agentsChain.map((agentsFile) =>
          input.includeContents
            ? { ...agentsFile }
            : {
                path: agentsFile.path,
                relativePath: agentsFile.relativePath,
                bytes: Buffer.byteLength(agentsFile.contents, "utf8")
              }
        )
      };
    }
  };
}
