import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";

import type {
  EditApplyPolicy,
  EditOp,
  EditOpResult,
  SearchReplaceEditOp,
  WholeFileEditOp
} from "./editFormats.js";
import { EditApplyPolicySchema, EditOpSchema } from "./editFormats.js";

export class EditApplyError extends Error {
  constructor(
    message: string,
    readonly opId: string,
    readonly path: string,
    readonly diagnostics: readonly string[]
  ) {
    super(message);
    this.name = "EditApplyError";
  }
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function detectLineTerminator(text: string): string {
  if (text.includes("\r\n")) return "\r\n";
  return "\n";
}

/**
 * Apply a validated edit op to the workspace. All writes are atomic:
 * the target is written to a temp file next to the target, then renamed over
 * the original. This prevents half-written files on crash or cancellation.
 * Existing files are backed up to `<target>.bak` before the rename.
 */
export async function applyEditOp(
  repoRoot: string,
  op: EditOp,
  policy?: Partial<EditApplyPolicy>
): Promise<EditOpResult> {
  const effectivePolicy = EditApplyPolicySchema.parse({
    ...{ skipMisses: false, wholeFileFallbackOnMiss: false },
    ...policy
  });

  switch (op.kind) {
    case "search_replace":
      return applySearchReplace(repoRoot, op, effectivePolicy);
    case "whole_file":
      return applyWholeFile(repoRoot, op);
    default:
      // Exhaustiveness guard; discriminated union should make this unreachable.
      throw new EditApplyError(
        `Unsupported edit op kind: ${String((op as EditOp).kind)}`,
        op.id,
        op.path,
        ["Edit operation kind is not implemented."]
      );
  }
}

/**
 * Apply a batch of edit ops sequentially, stopping at the first structural
 * error or unrecoverable miss. Returns per-op results so callers can produce
 * granular diagnostics without losing track of which file was touched.
 */
export async function applyEditOps(
  repoRoot: string,
  ops: unknown[],
  policy?: Partial<EditApplyPolicy>
): Promise<EditOpResult[]> {
  const results: EditOpResult[] = [];
  for (const raw of ops) {
    const op = EditOpSchema.parse(raw);
    const result = await applyEditOp(repoRoot, op, policy);
    results.push(result);
  }
  return results;
}

async function applySearchReplace(
  repoRoot: string,
  op: SearchReplaceEditOp,
  policy: EditApplyPolicy
): Promise<EditOpResult> {
  const targetPath = resolvePath(repoRoot, op.path);
  const original = await readFileText(targetPath);
  const terminator = detectLineTerminator(original);
  const normalizedOriginal = normalizeLineEndings(original);

  let current = normalizedOriginal;
  const blockResults: { index: number; applied: boolean; search: string }[] = [];
  let anyApplied = false;

  for (const [index, block] of op.blocks.entries()) {
    const search = normalizeLineEndings(block.search);
    const replace = normalizeLineEndings(block.replace);

    // Empty search is rejected by schema .min(1); guard at runtime for
    // defense-in-depth so it never corrupts current for subsequent blocks.
    if (search === "") {
      blockResults.push({ index, applied: false, search });
      continue;
    }

    if (!current.includes(search)) {
      blockResults.push({ index, applied: false, search });
      continue;
    }

    const beforeReplace = current;
    current = current.split(search).join(replace);
    const didChange = current !== beforeReplace;

    blockResults.push({ index, applied: didChange, search });
    anyApplied ||= didChange;
  }

  const missedBlocks = blockResults.filter((b) => !b.applied);
  const diagnostics = missedBlocks.map(
    (b) => `Block ${b.index + 1} search text not found.`
  );

  if (missedBlocks.length > 0) {
    if (policy.wholeFileFallbackOnMiss) {
      const fallback: WholeFileEditOp = {
        kind: "whole_file",
        id: `${op.id}:fallback`,
        path: op.path,
        contents: normalizeLineEndings(op.blocks[0]?.replace ?? ""),
        allowOverwrite: true
      };
      return applyWholeFile(repoRoot, fallback);
    }

    if (!policy.skipMisses) {
      throw new EditApplyError(
        `Search/replace op ${op.id} missed ${missedBlocks.length} block(s).`,
        op.id,
        op.path,
        diagnostics
      );
    }

    return {
      id: op.id,
      path: op.path,
      applied: false,
      fallback: false,
      diagnostics
    };
  }

  const finalContents =
    terminator === "\r\n" ? current.replace(/\n/g, "\r\n") : current;

  await atomicWrite(targetPath, finalContents);

  return {
    id: op.id,
    path: op.path,
    applied: anyApplied && finalContents !== original,
    fallback: false,
    diagnostics: []
  };
}

async function applyWholeFile(
  repoRoot: string,
  op: WholeFileEditOp
): Promise<EditOpResult> {
  const targetPath = resolvePath(repoRoot, op.path);

  if (existsSync(targetPath) && !op.allowOverwrite) {
    throw new EditApplyError(
      `Whole-file op ${op.id} would overwrite existing file; set allowOverwrite=true.`,
      op.id,
      op.path,
      ["Target file already exists and allowOverwrite is false."]
    );
  }

  await atomicWrite(targetPath, op.contents);

  return {
    id: op.id,
    path: op.path,
    applied: true,
    fallback: true,
    diagnostics: []
  };
}

async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp`;
  const backupPath = `${targetPath}.bak`;

  if (existsSync(targetPath)) {
    await copyFile(targetPath, backupPath);
  }

  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, targetPath);
}

async function copyFile(source: string, destination: string): Promise<void> {
  // Node 18+ preserve mode/timestamps; backup is best-effort.
  await new Promise<void>((resolve, reject) => {
    const readStream = createReadStream(source);
    const writeStream = createWriteStream(destination);
    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    readStream.pipe(writeStream);
  });
}

function createWriteStream(path: string) {
  // Import on demand to keep the top-level import set clean.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs");
  return fs.createWriteStream(path);
}

function resolvePath(repoRoot: string, path: string): string {
  return resolve(repoRoot, path);
}

async function readFileText(path: string): Promise<string> {
  if (!existsSync(path)) {
    throw new EditApplyError(
      "File not found.",
      "unknown",
      path,
      [`Target file does not exist: ${path}`]
    );
  }
  return readFile(path, "utf8");
}

/**
 * Pipe a readable to a string. Used in tests to verify backup contents without
 * blocking the event loop with a large file read.
 */
export async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
