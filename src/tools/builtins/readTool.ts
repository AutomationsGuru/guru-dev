import { existsSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
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
    /** Byte offset for the next non-overlapping page. */
    nextOffset: z.number().int().nonnegative().optional(),
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
    description:
      "Read a bounded byte window with secret-aware text output. UTF-8 characters are kept whole, so a window may extend by at most three bytes; use nextOffset for the following page.",
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

      const handle = await open(targetPath, "r");
      try {
        const sample = await readAt(handle, Math.min(info.size, 4096), 0);
        const binary = looksBinary(sample);
        if (binary && !input.allowImage) {
          return { path: rel, exists: true, isBinary: true, truncated: false, offset: input.offset, bytesRead: 0, blockers: ["Binary/image reads require allowImage=true or a dedicated sidecar."], summary: "Read blocked by binary/image policy." };
        }

        const window = await readUtf8Window(handle, info.size, input.offset, input.limit);
        const contents = window.bytes.toString("utf8");
        const truncated = window.nextOffset < info.size;
        const policy: ToolPolicy = { repoRoot, riskyPathPatterns: [], secretAllowList: options.secretAllowList ?? [], allowRiskyPaths: false };
        const contentDecision = guardContent([{ name: "contents", value: contents }], policy);
        if (!contentDecision.allowed) {
          return {
            path: rel,
            exists: true,
            isBinary: binary,
            truncated,
            offset: input.offset,
            bytesRead: window.bytes.length,
            nextOffset: window.nextOffset,
            blockers: [...contentDecision.blockers],
            summary: "Read output blocked by sensitive-content policy."
          };
        }

        return {
          path: rel,
          exists: true,
          isBinary: binary,
          truncated,
          offset: input.offset,
          bytesRead: window.bytes.length,
          nextOffset: window.nextOffset,
          contents,
          blockers: [],
          summary: `Read ${window.bytes.length} byte(s) from ${rel}; continue at byte ${window.nextOffset}.`
        };
      } finally {
        await handle.close();
      }
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

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Read only the requested neighborhood. A maximum three-byte look-behind and
 * look-ahead lets us include a whole UTF-8 code point when the caller's byte
 * boundary lands inside it, preventing replacement characters and page loss.
 */
async function readUtf8Window(
  handle: FileHandle,
  fileSize: number,
  offset: number,
  limit: number
): Promise<{ readonly bytes: Buffer; readonly nextOffset: number }> {
  if (offset >= fileSize) {
    return { bytes: Buffer.alloc(0), nextOffset: fileSize };
  }

  const scanStart = Math.max(0, offset - 3);
  const targetEnd = Math.min(fileSize, offset + limit);
  const scanEnd = Math.min(fileSize, targetEnd + 3);
  const scanned = await readAt(handle, scanEnd - scanStart, scanStart);

  let start = offset - scanStart;
  while (start > 0 && isUtf8Continuation(scanned[start])) {
    start -= 1;
  }

  let end = targetEnd - scanStart;
  while (end < scanned.length && isUtf8Continuation(scanned[end])) {
    end += 1;
  }

  return {
    bytes: scanned.subarray(start, end),
    nextOffset: scanStart + end
  };
}
