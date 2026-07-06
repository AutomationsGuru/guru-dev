import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, guardWritePath, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

export const PiWriteToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    contents: z.string(),
    overwrite: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    allowRiskyPaths: z.boolean().default(false)
  })
  .strict();

export const PiWriteToolOutputSchema = z
  .object({
    applied: z.boolean(),
    dryRun: z.boolean(),
    path: z.string(),
    bytesWritten: z.number().int().nonnegative().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export interface PiWriteToolOptions {
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly allowRiskyPaths?: boolean;
}

export function createPiWriteTool(options: PiWriteToolOptions = { riskyPathPatterns: [], secretAllowList: [] }): ToolDefinition<typeof PiWriteToolInputSchema, typeof PiWriteToolOutputSchema> {
  return {
    id: "write",
    title: "Write file",
    description: "Write tool with parent-directory creation, overwrite policy, dry-run default, and secret guards.",
    inputSchema: PiWriteToolInputSchema,
    outputSchema: PiWriteToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const targetPath = resolve(repoRoot, input.path);
      const rel = relative(repoRoot, targetPath);
      const policy: ToolPolicy = {
        repoRoot,
        riskyPathPatterns: options.riskyPathPatterns,
        secretAllowList: options.secretAllowList,
        allowRiskyPaths: Boolean(options.allowRiskyPaths) || input.allowRiskyPaths
      };
      const blockers = [...guardWritePath(input.path, policy).blockers, ...guardContent([{ name: "contents", value: input.contents }], policy).blockers];
      if (!input.overwrite && existsSync(targetPath)) {
        blockers.push("Target file already exists; set overwrite=true to replace it.");
      }

      if (blockers.length > 0) {
        return { applied: false, dryRun: input.dryRun, path: rel || input.path, blockers, summary: `Write blocked by ${blockers.length} policy check(s).` };
      }

      const bytesWritten = Buffer.byteLength(input.contents, "utf8");
      if (input.dryRun) {
        return { applied: false, dryRun: true, path: rel, bytesWritten, blockers: [], summary: "Dry run only; no file was written." };
      }

      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, input.contents, "utf8");
      return { applied: true, dryRun: false, path: rel, bytesWritten, blockers: [], summary: `Wrote ${bytesWritten} byte(s) to ${rel}.` };
    }
  };
}
