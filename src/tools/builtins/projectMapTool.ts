import { statSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { buildProjectMap } from "../projectMap/buildProjectMap.js";
import type { ToolDefinition } from "../registry.js";

const ProjectMapFileSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    /** Light symbol sketch for TS/JS files; absent when not sketched. */
    symbols: z.array(z.string()).optional()
  })
  .strict();

export const ProjectMapToolInputSchema = z
  .object({
    /** Directory to map. Defaults to the tool execution cwd, then process cwd. */
    rootPath: z.string().trim().min(1).optional(),
    /** Max directory depth descended below root. Default 8, hard cap 24. */
    maxDepth: z.number().int().min(1).max(24).optional(),
    /** Max files collected. Default 500, hard cap 2_000. */
    maxFiles: z.number().int().min(1).max(2_000).optional(),
    /** Set false for a tree-only map with no TS/JS symbol sketch. */
    includeSymbols: z.boolean().default(true),
    /** Max rendered-text characters. Default 24_000, hard cap 100_000. */
    maxTextChars: z.number().int().min(1_000).max(100_000).optional()
  })
  .strict();

export const ProjectMapToolOutputSchema = z
  .object({
    root: z.string(),
    truncated: z.boolean(),
    totalFiles: z.number().int().nonnegative(),
    totalDirs: z.number().int().nonnegative(),
    files: z.array(ProjectMapFileSchema),
    /** Indented tree text with inline symbol sketches, sized for a model turn. */
    text: z.string()
  })
  .strict();

export type ProjectMapToolInput = z.infer<typeof ProjectMapToolInputSchema>;
export type ProjectMapToolOutput = z.infer<typeof ProjectMapToolOutputSchema>;

/**
 * Project map observation (IDEA-F8-PROJECT-MAP-01): bounded, gitignore-aware
 * tree + light TS/JS symbol sketch for large repos. Read-only; every cap is
 * enforced inside buildProjectMap so the observation can never hang on a
 * huge tree, follow a symlink cycle, or surface .env* files.
 */
export function createProjectMapTool(): ToolDefinition<
  typeof ProjectMapToolInputSchema,
  typeof ProjectMapToolOutputSchema
> {
  return {
    id: "project.map.build",
    title: "Build project map",
    description:
      "Walk the project with .gitignore honored (bounded depth/file caps) and return a structured tree plus a light TS/JS export symbol sketch, with pre-rendered text sized for a model turn.",
    inputSchema: ProjectMapToolInputSchema,
    outputSchema: ProjectMapToolOutputSchema,
    execute(input, context) {
      const root = resolve(input.rootPath ?? context.cwd ?? process.cwd());
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(root);
      } catch {
        throw new Error(`project.map.build: rootPath does not exist: ${root}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`project.map.build: rootPath is not a directory: ${root}`);
      }
      return buildProjectMap(root, {
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.maxFiles !== undefined ? { maxFiles: input.maxFiles } : {}),
        includeSymbols: input.includeSymbols,
        ...(input.maxTextChars !== undefined ? { maxTextChars: input.maxTextChars } : {})
      });
    }
  };
}
