import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, guardWritePath, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

export const PiExactEditToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    allowRiskyPaths: z.boolean().default(false)
  })
  .strict();

export const PiExactEditToolOutputSchema = z
  .object({
    applied: z.boolean(),
    dryRun: z.boolean(),
    path: z.string(),
    replacements: z.number().int().nonnegative(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export interface PiExactEditToolOptions {
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly allowRiskyPaths?: boolean;
}

export function createPiExactEditTool(options: PiExactEditToolOptions = { riskyPathPatterns: [], secretAllowList: [] }): ToolDefinition<typeof PiExactEditToolInputSchema, typeof PiExactEditToolOutputSchema> {
  return {
    id: "edit",
    title: "Exact edit",
    description: "Exact text replacement with uniqueness validation and dry-run default.",
    inputSchema: PiExactEditToolInputSchema,
    outputSchema: PiExactEditToolOutputSchema,
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
      const blockers = [...guardWritePath(input.path, policy).blockers, ...guardContent([{ name: "newText", value: input.newText }], policy).blockers];

      if (!existsSync(targetPath)) {
        blockers.push("Target file does not exist.");
      }

      if (blockers.length > 0) {
        return { applied: false, dryRun: input.dryRun, path: rel || input.path, replacements: 0, blockers, summary: `Edit blocked by ${blockers.length} policy check(s).` };
      }

      const before = await readFile(targetPath, "utf8");
      const occurrences = countOccurrences(before, input.oldText);
      if (occurrences === 0) {
        return { applied: false, dryRun: input.dryRun, path: rel, replacements: 0, blockers: ["oldText was not found in the target file."], summary: "Edit blocked because oldText was not found." };
      }
      if (!input.replaceAll && occurrences !== 1) {
        return { applied: false, dryRun: input.dryRun, path: rel, replacements: 0, blockers: [`oldText matched ${occurrences} times; exact edit requires a unique match unless replaceAll=true.`], summary: "Edit blocked by uniqueness validation." };
      }

      const after = input.replaceAll ? before.split(input.oldText).join(input.newText) : before.replace(input.oldText, input.newText);
      if (input.dryRun) {
        return { applied: false, dryRun: true, path: rel, replacements: input.replaceAll ? occurrences : 1, blockers: [], summary: "Dry run only; no file was edited." };
      }

      await writeFile(targetPath, after, "utf8");
      return { applied: true, dryRun: false, path: rel, replacements: input.replaceAll ? occurrences : 1, blockers: [], summary: `Applied ${input.replaceAll ? occurrences : 1} replacement(s) to ${rel}.` };
    }
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
