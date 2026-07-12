import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { MandateDecision } from "./evaluate.js";

/**
 * Content-preservation guard — the mechanical arm of PRESERVE, DON'T REPLACE
 * (THERE §12; the behavioral rule lives in Guru's system prompt).
 *
 * The cardinal rule is that content exists for a reason: the default is to improve,
 * enhance, clarify, or expand — never to summarize down, cut, or overwrite with a
 * shorter interpretation. The prompt asks the model to honor that; this is the
 * backstop for the moment it doesn't. A write or edit that GUTS existing content —
 * overwriting a rich file with a much shorter one, or replacing a large block with a
 * fraction of it — is a destructive-class action. It gets the same "are you sure
 * this needs to go?" double-check as `rm -rf`, in EVERY mode, YOLO included.
 *
 * It deliberately never fires on the safe majority: growth, small edits, brand-new
 * files, or dry-run previews. Only a genuine gutting trips it.
 */

/** A change must remove at least this many net lines to count as a substantial cut. */
export const SUBSTANTIAL_REMOVAL_LINES = 15;
/** ...and the survivor must be under this fraction of the original — a gutting, not a trim. */
export const GUTTING_SURVIVOR_FRACTION = 0.5;
/** Regions/files smaller than this are too small to gut meaningfully — never gated. */
export const MIN_REGION_LINES = 20;

export interface ContentRemovalVerdict {
  /** Net lines removed (before − after). */
  readonly removedLines: number;
  /** Operator-facing explanation for the double-check prompt. */
  readonly reason: string;
}

/** Line count of a block. Empty string = 0 lines; otherwise newline-delimited. */
function lineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length;
}

/**
 * Compares a before/after pair and returns a verdict when the change GUTS the
 * content — a substantial net removal that leaves under half the original standing.
 * Returns null for growth, trims, and blocks too small to gut.
 */
function assessGutting(beforeText: string, afterText: string, verb: string): ContentRemovalVerdict | null {
  const before = lineCount(beforeText);
  const after = lineCount(afterText);
  const removed = before - after;
  if (before < MIN_REGION_LINES) {
    return null; // too small to gut meaningfully
  }
  if (removed < SUBSTANTIAL_REMOVAL_LINES) {
    return null; // grew, held steady, or trimmed only a little
  }
  if (after >= before * GUTTING_SURVIVOR_FRACTION) {
    return null; // a trim, not a gutting — over half survives
  }
  return {
    removedLines: removed,
    reason: `this ${verb} removes ${removed} lines (${before} → ${after}) — a substantial content cut; confirm the replacement preserves what matters instead of summarizing it away`
  };
}

export interface PreservationProbe {
  /** Resolves the tool's (possibly relative) target path to an absolute path. */
  readonly resolvePath: (path: string) => string;
  /** Reads current file content at an absolute path; returns null if absent/unreadable. */
  readonly readExisting: (absolutePath: string) => string | null;
}

/**
 * Returns a verdict when a `write` or `edit` call would REMOVE substantial existing
 * content, else null. `write` overwrites the whole file, so the existing file is the
 * "before"; `edit` replaces `oldText` with `newText`, which ARE the before/after of
 * the touched region (no file read needed). Dry runs remove nothing and are skipped.
 */
export function assessContentRemoval(toolId: string, input: unknown, probe: PreservationProbe): ContentRemovalVerdict | null {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (record.dryRun === true) {
    return null; // a preview removes nothing
  }

  if (toolId === "edit") {
    const oldText = typeof record.oldText === "string" ? record.oldText : "";
    const newText = typeof record.newText === "string" ? record.newText : "";
    if (oldText.length === 0) {
      return null;
    }
    return assessGutting(oldText, newText, "edit");
  }

  // Full-file overwrite tools share the same gutting probe.
  if (toolId === "write" || toolId === "fs.edit.apply") {
    const path = typeof record.path === "string" ? record.path : "";
    const contents = typeof record.contents === "string" ? record.contents : "";
    if (path.length === 0) {
      return null;
    }
    // createOnly never overwrites existing content.
    if (toolId === "fs.edit.apply" && record.mode === "createOnly") {
      return null;
    }
    const before = probe.readExisting(probe.resolvePath(path));
    if (before === null) {
      return null; // brand-new file — nothing is being removed
    }
    return assessGutting(before, contents, "overwrite");
  }

  return null;
}


/**
 * PRESERVE, DON'T REPLACE mechanical backstop shared by EVERY approval path —
 * TUI main turn, swarm workers, and the AgentSession engine default (SDK/RPC).
 * Escalates a gutting write/edit/fs.edit.apply to destructive-class so the
 * hard-edge rules double-check it in every mode, YOLO included.
 */
export function applyPreservationGuard(
  decision: MandateDecision,
  toolId: string,
  input: unknown,
  defaultRepoRoot: string
): MandateDecision {
  if (decision.outcome === "deny") {
    return decision;
  }
  const removal = assessContentRemoval(toolId, input, {
    resolvePath: (p) => {
      const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
      const root =
        typeof record.repoRoot === "string" && record.repoRoot.length > 0 ? record.repoRoot : defaultRepoRoot;
      return resolvePath(root, p);
    },
    readExisting: (abs) => {
      try {
        return readFileSync(abs, "utf8");
      } catch (error) {
        // Only a genuinely missing file is "brand new"; other errors must not
        // silently skip the guard (EACCES / EISDIR / I/O).
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }
  });
  if (!removal) {
    return decision;
  }
  return {
    outcome: "escalate",
    reason: `content preservation — ${removal.reason}`,
    verbs: decision.verbs.includes("destructive") ? decision.verbs : [...decision.verbs, "destructive"]
  };
}
