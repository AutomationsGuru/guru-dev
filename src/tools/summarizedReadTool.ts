import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

import { guardContent, type ToolPolicy } from "../safety/policyGuard.js";
import type { ToolDefinition } from "./registry.js";

const MAX_STRUCTURE_ENTRIES = 100;
const HEADING_PATTERN = /^#{1,6}\s+/;
const DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+\w+/;

export interface SummarizeResult {
  readonly summarized: boolean;
  readonly head: string;
  readonly structure: readonly string[];
  readonly totalBytes: number;
  readonly truncated: boolean;
}

/**
 * Extract an outline of the text: markdown headings verbatim, plus code
 * declarations (function/class/interface/type/const/let/var/enum, optionally
 * exported/async) prefixed with their 1-based line number. Capped at 100
 * entries with a final "… (N more)" note when elided.
 */
export function extractStructure(text: string): string[] {
  const structure: string[] = [];
  const lines = text.split("\n");
  let elided = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let entry: string | undefined;
    if (HEADING_PATTERN.test(line)) {
      entry = line;
    } else if (DECLARATION_PATTERN.test(line)) {
      entry = `L${index + 1}: ${line}`;
    }

    if (entry === undefined) {
      continue;
    }

    if (structure.length < MAX_STRUCTURE_ENTRIES) {
      structure.push(entry);
    } else {
      elided += 1;
    }
  }

  if (elided > 0) {
    structure.push(`… (${elided} more)`);
  }

  return structure;
}

/**
 * Cut text to at most maxBytes of UTF-8 without splitting a code point, and
 * prefer the last line boundary within the budget. A single line longer than
 * maxBytes is cut at a code-point boundary.
 */
function utf8SafeHead(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }

  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes so the cut lands on a code-point boundary.
  while (end > 0) {
    const byte = buffer[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }

  const candidate = buffer.subarray(0, end).toString("utf8");
  const lastNewline = candidate.lastIndexOf("\n");
  if (lastNewline >= 0) {
    return candidate.slice(0, lastNewline + 1);
  }
  return candidate;
}

/**
 * Summarize text that exceeds maxBytes: keep a UTF-8-safe, line-aligned head
 * plus an extracted structural outline. Small text passes through whole.
 */
export function summarizeText(text: string, maxBytes: number): SummarizeResult {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) {
    return { summarized: false, head: text, structure: [], totalBytes, truncated: false };
  }

  return {
    summarized: true,
    head: utf8SafeHead(text, maxBytes),
    structure: extractStructure(text),
    totalBytes,
    truncated: true
  };
}

export const SummarizedReadToolInputSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    path: z.string().trim().min(1),
    maxBytes: z.number().int().positive().max(100_000).default(20_000)
  })
  .strict();

export const SummarizedReadToolOutputSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    isBinary: z.boolean().default(false),
    summarized: z.boolean().default(false),
    truncated: z.boolean().default(false),
    totalBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive(),
    contents: z.string().optional(),
    head: z.string().optional(),
    structure: z.array(z.string()).optional(),
    blockers: z.array(z.string()),
    summary: z.string()
  })
  .strict();

export type SummarizedReadToolInput = z.infer<typeof SummarizedReadToolInputSchema>;
export type SummarizedReadToolOutput = z.infer<typeof SummarizedReadToolOutputSchema>;

export interface SummarizedReadToolOptions {
  readonly secretAllowList?: readonly string[];
}

export function createSummarizedReadTool(
  options: SummarizedReadToolOptions = {}
): ToolDefinition<typeof SummarizedReadToolInputSchema, typeof SummarizedReadToolOutputSchema> {
  return {
    id: "summarized_read",
    title: "Read file with summary",
    description:
      "Read a text file, returning full contents when small or a bounded UTF-8-safe head plus a structural outline (headings and declarations) when it exceeds maxBytes. Output is screened for secrets.",
    inputSchema: SummarizedReadToolInputSchema,
    outputSchema: SummarizedReadToolOutputSchema,
    effect: "read-only",
    async execute(input) {
      const repoRoot = resolve(input.repoRoot);
      const targetPath = resolve(repoRoot, input.path);
      const rel = relative(repoRoot, targetPath);
      const blockers = containmentBlockers(repoRoot, targetPath);

      const base = {
        path: input.path,
        exists: false,
        isBinary: false,
        summarized: false,
        truncated: false,
        totalBytes: 0,
        maxBytes: input.maxBytes,
        blockers: [] as string[],
        summary: ""
      };

      if (blockers.length > 0) {
        return { ...base, blockers, summary: "Read blocked by repository containment policy." };
      }

      if (!existsSync(targetPath)) {
        return { ...base, path: rel, summary: "File does not exist." };
      }

      const info = await stat(targetPath);
      if (!info.isFile()) {
        return {
          ...base,
          path: rel,
          exists: true,
          blockers: ["Target is not a regular file."],
          summary: "Read blocked because target is not a file."
        };
      }

      const handle = await readFile(targetPath);
      const sample = handle.subarray(0, Math.min(handle.length, 4096));
      if (sample.includes(0)) {
        return {
          ...base,
          path: rel,
          exists: true,
          isBinary: true,
          totalBytes: handle.length,
          blockers: ["Binary file reads are not supported by summarized_read."],
          summary: "Read blocked by binary policy."
        };
      }

      const text = handle.toString("utf8");
      const result = summarizeText(text, input.maxBytes);
      const guardedText = result.summarized ? [result.head, ...result.structure].join("\n") : result.head;

      const policy: ToolPolicy = {
        repoRoot,
        riskyPathPatterns: [],
        secretAllowList: options.secretAllowList ?? [],
        allowRiskyPaths: false
      };
      const contentDecision = guardContent([{ name: "contents", value: guardedText }], policy);
      if (!contentDecision.allowed) {
        return {
          ...base,
          path: rel,
          exists: true,
          totalBytes: result.totalBytes,
          blockers: [...contentDecision.blockers],
          summary: "Read output blocked by sensitive-content policy."
        };
      }

      if (!result.summarized) {
        return {
          ...base,
          path: rel,
          exists: true,
          totalBytes: result.totalBytes,
          contents: result.head,
          summary: `Returned full text (${result.totalBytes} bytes).`
        };
      }

      const headBytes = Buffer.byteLength(result.head, "utf8");
      return {
        ...base,
        path: rel,
        exists: true,
        summarized: true,
        truncated: true,
        totalBytes: result.totalBytes,
        head: result.head,
        structure: [...result.structure],
        summary: `Summarized ${result.totalBytes}-byte file: head ${headBytes} bytes + ${result.structure.length} structure lines.`
      };
    }
  };
}

function containmentBlockers(repoRoot: string, targetPath: string): string[] {
  const rel = relative(repoRoot, targetPath);
  return rel.startsWith("..") || /^[A-Za-z]:/.test(rel) ? ["Target path escapes the repository root (path redacted)."] : [];
}
