import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, type ToolPolicy } from "../../safety/policyGuard.js";
import type { ToolDefinition } from "../registry.js";

export const PiReadToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(100_000).default(20_000),
    allowImage: z.boolean().default(false)
  })
  .strict();

export const PiReadToolOutputSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    isBinary: z.boolean().default(false),
    truncated: z.boolean().default(false),
    offset: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    contents: z.string().optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export type PiReadToolInput = z.infer<typeof PiReadToolInputSchema>;
export type PiReadToolOutput = z.infer<typeof PiReadToolOutputSchema>;

export interface PiReadToolOptions {
  readonly secretAllowList?: readonly string[];
}

export function createPiReadTool(options: PiReadToolOptions = {}): ToolDefinition<typeof PiReadToolInputSchema, typeof PiReadToolOutputSchema> {
  return {
    id: "read",
    title: "Read file",
    description: "Read tool with offset/limit and bounded, secret-aware text output.",
    inputSchema: PiReadToolInputSchema,
    outputSchema: PiReadToolOutputSchema,
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const targetPath = resolve(repoRoot, input.path);
      const rel = relative(repoRoot, targetPath);
      const blockers = containmentBlockers(repoRoot, targetPath);

      if (blockers.length > 0) {
        return { path: input.path, exists: false, isBinary: false, truncated: false, offset: input.offset, bytesRead: 0, blockers, summary: "Read blocked by repository containment policy." };
      }

      if (!existsSync(targetPath)) {
        return { path: rel, exists: false, isBinary: false, truncated: false, offset: input.offset, bytesRead: 0, blockers: [], summary: "File does not exist." };
      }

      const info = await stat(targetPath);
      if (!info.isFile()) {
        return { path: rel, exists: true, isBinary: false, truncated: false, offset: input.offset, bytesRead: 0, blockers: ["Target is not a regular file."], summary: "Read blocked because target is not a file." };
      }

      const buffer = await readFile(targetPath);
      const binary = looksBinary(buffer);
      if (binary && !input.allowImage) {
        return { path: rel, exists: true, isBinary: true, truncated: false, offset: input.offset, bytesRead: 0, blockers: ["Binary/image reads require allowImage=true or a dedicated sidecar."], summary: "Read blocked by binary/image policy." };
      }

      const slice = buffer.subarray(input.offset, Math.min(buffer.length, input.offset + input.limit));
      const contents = slice.toString("utf8");
      const policy: ToolPolicy = { repoRoot, riskyPathPatterns: [], secretAllowList: options.secretAllowList ?? [], allowRiskyPaths: false };
      const contentDecision = guardContent([{ name: "contents", value: contents }], policy);
      if (!contentDecision.allowed) {
        return { path: rel, exists: true, isBinary: binary, truncated: input.offset + input.limit < buffer.length, offset: input.offset, bytesRead: slice.length, blockers: [...contentDecision.blockers], summary: "Read output blocked by sensitive-content policy." };
      }

      return {
        path: rel,
        exists: true,
        isBinary: binary,
        truncated: input.offset + input.limit < buffer.length,
        offset: input.offset,
        bytesRead: slice.length,
        contents,
        blockers: [],
        summary: `Read ${slice.length} byte(s) from ${rel}.`
      };
    }
  };
}

function containmentBlockers(repoRoot: string, targetPath: string): string[] {
  const rel = relative(repoRoot, targetPath);
  return rel.startsWith("..") || /^[A-Za-z]:/.test(rel) ? ["Target path escapes the repository root (path redacted)."] : [];
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}
