import { createHash } from "node:crypto";

export interface HashlinePatch {
  /** SHA-256 hash of the whole file content observed before creating this patch. */
  readonly contentHash: string;
  /** Inclusive, one-indexed source line range to replace. */
  readonly startLine: number;
  readonly endLine: number;
  /** Replacement text, without an implicit trailing newline. */
  readonly replacement: string;
}

export interface HashlineEditApplied {
  readonly applied: true;
  readonly content: string;
  readonly contentHash: string;
}

export interface HashlineEditRejected {
  readonly applied: false;
  /** The original content is returned unchanged when the patch is rejected. */
  readonly content: string;
  readonly reason: "stale-hash" | "invalid-range";
  readonly expectedHash: string;
  readonly actualHash: string;
}

export type HashlineEditResult = HashlineEditApplied | HashlineEditRejected;

/**
 * Returns a stable full-content anchor for a hashline patch.
 *
 * This module deliberately accepts and returns strings only. Callers that write
 * an applied result to disk remain responsible for their backup-preserving path.
 */
export function hashlineContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Applies one line-range patch only when its full-content anchor still matches.
 */
export function applyHashlineEdit(content: string, patch: HashlinePatch): HashlineEditResult {
  const actualHash = hashlineContentHash(content);
  if (actualHash !== patch.contentHash) {
    return {
      applied: false,
      content,
      reason: "stale-hash",
      expectedHash: patch.contentHash,
      actualHash
    };
  }

  const { lines, hasTrailingNewline } = splitLines(content);
  if (patch.startLine < 1 || patch.endLine < patch.startLine || patch.endLine > lines.length) {
    return {
      applied: false,
      content,
      reason: "invalid-range",
      expectedHash: patch.contentHash,
      actualHash
    };
  }

  const replacementLines = patch.replacement === "" ? [] : patch.replacement.split("\n");
  const updatedLines = [
    ...lines.slice(0, patch.startLine - 1),
    ...replacementLines,
    ...lines.slice(patch.endLine)
  ];
  const updatedContent = `${updatedLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`;

  return {
    applied: true,
    content: updatedContent,
    contentHash: hashlineContentHash(updatedContent)
  };
}

function splitLines(content: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (content === "") {
    return { lines: [], hasTrailingNewline: false };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  return { lines, hasTrailingNewline };
}
