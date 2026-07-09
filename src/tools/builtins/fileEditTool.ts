import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, guardWritePath, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

export const FileEditToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    mode: z.enum(["overwrite", "createOnly"]).default("createOnly"),
    contents: z.string(),
    dryRun: z.boolean().default(true),
    allowRiskyPaths: z.boolean().default(false)
  })
  .strict();

export const FileEditToolOutputSchema = z
  .object({
    applied: z.boolean(),
    dryRun: z.boolean(),
    path: z.string(),
    bytesWritten: z.number().int().nonnegative().optional(),
    previewDiff: z.string().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export type FileEditToolInput = z.infer<typeof FileEditToolInputSchema>;
export type FileEditToolOutput = z.infer<typeof FileEditToolOutputSchema>;

export interface FileEditToolOptions {
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly allowRiskyPaths?: boolean;
}

export function createFileEditTool(
  options: FileEditToolOptions = { riskyPathPatterns: [], secretAllowList: [], allowRiskyPaths: false }
): ToolDefinition<typeof FileEditToolInputSchema, typeof FileEditToolOutputSchema> {
  return {
    id: "fs.edit.apply",
    title: "Apply bounded file edit",
    description:
      "Create or overwrite a file inside a repository after path and secret-policy checks (dry-run default). " +
      "PRESERVE, DON'T REPLACE: on overwrite, default to improving, enhancing, clarifying, or expanding — ask whether anything really needs to go (yes/no) and whether it can be enriched instead (yes/no) before cutting. A substantial content cut is double-checked even in YOLO.",
    inputSchema: FileEditToolInputSchema,
    outputSchema: FileEditToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const targetPath = resolve(repoRoot, input.path);
      const relativePath = relative(repoRoot, targetPath);
      const policy: ToolPolicy = {
        repoRoot,
        riskyPathPatterns: options.riskyPathPatterns,
        secretAllowList: options.secretAllowList,
        allowRiskyPaths: (options.allowRiskyPaths ?? false) || input.allowRiskyPaths
      };
      const pathDecision = guardWritePath(input.path, policy);
      const contentDecision = guardContent([{ name: "contents", value: input.contents }], policy);
      const blockers = [...pathDecision.blockers, ...contentDecision.blockers];

      if (blockers.length > 0) {
        return {
          applied: false,
          dryRun: input.dryRun,
          path: relativePath,
          blockers,
          summary: `File edit blocked by ${blockers.length} policy check(s).`
        };
      }

      if (input.mode === "createOnly" && existsSync(targetPath)) {
        return {
          applied: false,
          dryRun: input.dryRun,
          path: relativePath,
          blockers: ["Target file already exists; createOnly refused to overwrite it."],
          summary: "File edit blocked because target exists."
        };
      }

      const previous = existsSync(targetPath) ? await readFile(targetPath, "utf8") : "";
      const previewDiff = buildPreviewDiff(relativePath, previous, input.contents);
      const bytesWritten = Buffer.byteLength(input.contents, "utf8");

      if (input.dryRun) {
        return {
          applied: false,
          dryRun: true,
          path: relativePath,
          bytesWritten,
          previewDiff,
          blockers: [],
          summary: "Dry run only; no file was written."
        };
      }

      await writeFile(targetPath, input.contents, "utf8");

      return {
        applied: true,
        dryRun: false,
        path: relativePath,
        bytesWritten,
        previewDiff,
        blockers: [],
        summary: `Wrote ${bytesWritten} byte(s) to ${relativePath}.`
      };
    }
  };
}

function buildPreviewDiff(relativePath: string, before: string, after: string): string {
  const beforeBytes = Buffer.byteLength(before, "utf8");
  const afterBytes = Buffer.byteLength(after, "utf8");

  if (before === after) {
    return `--- ${relativePath}\n+++ ${relativePath}\n(no byte-level changes; content redacted)`;
  }

  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    `- redacted previous content (${beforeBytes} byte(s))`,
    `+ redacted proposed content (${afterBytes} byte(s))`
  ].join("\n");
}
