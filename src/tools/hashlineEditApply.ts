import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, guardWritePath, type ToolPolicy } from "../safety/policyGuard.js";
import type { ToolDefinition } from "./registry.js";

/**
 * Hashline edit apply (IDEA-F501-HASH-01 / R-OMP-HASH).
 *
 * Content-hash anchored file edit: the caller supplies the SHA-256 of the file
 * content it last saw (`expectedHash`). The tool recomputes the on-disk hash and
 * rejects the write when they diverge — the file changed since the caller
 * captured its anchor, so the patch would land on stale content. A stale hash
 * never writes: it returns `applied: false, hashMatched: false` and the on-disk
 * file is left untouched.
 *
 * This is a freshness precondition, enforced in code at the write site — not a
 * prompt convention. It closes the clobber-on-race window that a plain
 * overwrite would have.
 */
export const HashlineEditApplyInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    /** SHA-256 (hex) of the on-disk content the caller anchored against. */
    expectedHash: z.string().trim().regex(/^[0-9a-f]{64}$/iu, "expectedHash must be a 64-char hex SHA-256"),
    contents: z.string(),
    dryRun: z.boolean().default(true),
    allowRiskyPaths: z.boolean().default(false)
  })
  .strict();

export const HashlineEditApplyOutputSchema = z
  .object({
    applied: z.boolean(),
    dryRun: z.boolean(),
    path: z.string(),
    hashMatched: z.boolean(),
    bytesWritten: z.number().int().nonnegative().optional(),
    previewDiff: z.string().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export type HashlineEditApplyInput = z.infer<typeof HashlineEditApplyInputSchema>;
export type HashlineEditApplyOutput = z.infer<typeof HashlineEditApplyOutputSchema>;

export interface HashlineEditApplyOptions {
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly allowRiskyPaths?: boolean;
}

export function createHashlineEditApplyTool(
  options: HashlineEditApplyOptions = { riskyPathPatterns: [], secretAllowList: [], allowRiskyPaths: false }
): ToolDefinition<typeof HashlineEditApplyInputSchema, typeof HashlineEditApplyOutputSchema> & {
  readonly hashContent: (value: string) => string;
} {
  const tool: ToolDefinition<typeof HashlineEditApplyInputSchema, typeof HashlineEditApplyOutputSchema> = {
    id: "fs.edit.hashline",
    title: "Apply content-hash anchored file edit",
    description:
      "Overwrite a file inside a repository only when an expected SHA-256 of its current content still " +
      "matches the on-disk hash. A stale hash (file changed since the anchor was captured) rejects without " +
      "writing. Path and secret-policy checks run first (dry-run default).",
    effect: "mutating",
    inputSchema: HashlineEditApplyInputSchema,
    outputSchema: HashlineEditApplyOutputSchema,
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

      // Hard edges resolve before the freshness check, before YOLO, before any write.
      const pathDecision = guardWritePath(input.path, policy);
      const contentDecision = guardContent([{ name: "contents", value: input.contents }], policy);
      const policyBlockers = [...pathDecision.blockers, ...contentDecision.blockers];

      if (policyBlockers.length > 0) {
        return {
          applied: false,
          dryRun: input.dryRun,
          path: relativePath,
          hashMatched: false,
          blockers: policyBlockers,
          summary: `File edit blocked by ${policyBlockers.length} policy check(s).`
        };
      }

      const current = existsSync(targetPath) ? await readFile(targetPath, "utf8") : "";
      const currentHash = hashContent(current);
      const hashMatched = currentHash === input.expectedHash.toLowerCase();

      if (!hashMatched) {
        // Stale anchor: never write. The on-disk content is left untouched.
        return {
          applied: false,
          dryRun: input.dryRun,
          path: relativePath,
          hashMatched: false,
          blockers: [
            `Stale content hash: on-disk hash ${currentHash} !== expected ${input.expectedHash.toLowerCase()} ` +
              "— the file changed since the anchor was captured; refusing to write."
          ],
          summary: "File edit rejected because the content-hash anchor is stale."
        };
      }

      const previewDiff = buildPreviewDiff(relativePath, current, input.contents);
      const bytesWritten = Buffer.byteLength(input.contents, "utf8");

      if (input.dryRun) {
        return {
          applied: false,
          dryRun: true,
          path: relativePath,
          hashMatched: true,
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
        hashMatched: true,
        bytesWritten,
        previewDiff,
        blockers: [],
        summary: `Wrote ${bytesWritten} byte(s) to ${relativePath} after a fresh content-hash anchor.`
      };
    }
  };

  return Object.assign(tool, { hashContent });
}

/**
 * Canonical content-hash used as the freshness anchor. Exposed so callers
 * compute the same digest the tool checks against.
 */
export function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
