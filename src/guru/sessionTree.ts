import type { ChildBranch, ReconstructedMessage } from "./sessionLog.js";

/**
 * Pure session-tree model + renderer (Session Tree wave, ADR
 * 2026-07-05-session-tree, THERE v2 §6). Turns a replayed session's message
 * chain plus its child branches into a numbered, foldable, filterable tree.
 * The fork-number → entryId map IS the select-to-branch model: `/fork <n>`
 * targets the user message numbered `n`. No TUI dependency — guru.ts colors the
 * rows; tests assert on the plain model.
 */

export type TreeFilter = "conversation" | "user" | "all";

export interface TreeRow {
  readonly kind: "message" | "branch";
  /** Present on user-message rows — the fork target number. */
  readonly forkNumber?: number;
  readonly entryId?: string;
  readonly role?: "system" | "user" | "assistant";
  /** Folded, single-line display label. */
  readonly text: string;
  readonly depth: number;
  /** Present on branch rows. */
  readonly childSessionId?: string;
}

export interface SessionTreeModel {
  readonly title: string;
  readonly rows: readonly TreeRow[];
  /** forkNumber → parent entry id, for `/fork <n>`. */
  readonly forkTargets: ReadonlyMap<number, string>;
}

export interface BuildTreeOptions {
  /** conversation = user+assistant (default); user = user only; all = incl. system notes. */
  readonly filter?: TreeFilter;
  /** Max chars for a folded label before it truncates. Default 72. */
  readonly foldWidth?: number;
}

export interface TreeSessionInput {
  readonly title: string;
  readonly messages: readonly ReconstructedMessage[];
  readonly entryIds: readonly string[];
}

const DEFAULT_FOLD_WIDTH = 72;

/** Collapse a message body to a single folded line no wider than `width`. */
export function foldLabel(content: string, width: number = DEFAULT_FOLD_WIDTH): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= width) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(1, width - 1))}…`;
}

export function buildSessionTree(
  session: TreeSessionInput,
  children: readonly ChildBranch[],
  options: BuildTreeOptions = {}
): SessionTreeModel {
  const filter: TreeFilter = options.filter ?? "conversation";
  const foldWidth = options.foldWidth ?? DEFAULT_FOLD_WIDTH;

  const branchesByEntry = new Map<string, ChildBranch[]>();
  const attached = new Set<string>();
  for (const branch of children) {
    const bucket = branchesByEntry.get(branch.parentEntryId) ?? [];
    bucket.push(branch);
    branchesByEntry.set(branch.parentEntryId, bucket);
  }

  const rows: TreeRow[] = [];
  const forkTargets = new Map<number, string>();
  let forkNumber = 0;

  const pushBranchRows = (entryId: string): void => {
    for (const branch of branchesByEntry.get(entryId) ?? []) {
      attached.add(branch.sessionId);
      const summary = branch.branchSummary ? ` — ${foldLabel(branch.branchSummary, foldWidth)}` : "";
      rows.push({
        kind: "branch",
        childSessionId: branch.sessionId,
        text: `branch: ${branch.title} (${branch.turnCount} turn${branch.turnCount === 1 ? "" : "s"})${summary}`,
        depth: 1
      });
    }
  };

  session.messages.forEach((message, index) => {
    const entryId = session.entryIds[index] ?? `m${index}`;
    if (message.role === "user") {
      forkNumber += 1;
      forkTargets.set(forkNumber, entryId);
    }
    const visible =
      filter === "all" ||
      (filter === "user" && message.role === "user") ||
      (filter === "conversation" && (message.role === "user" || message.role === "assistant"));
    if (visible) {
      rows.push({
        kind: "message",
        ...(message.role === "user" ? { forkNumber } : {}),
        entryId,
        role: message.role,
        text: foldLabel(message.content, foldWidth),
        depth: 0
      });
    }
    // Branches attach under the message they forked from, regardless of filter.
    pushBranchRows(entryId);
  });

  // Any child whose fork point wasn't among the shown entries (e.g. a legacy
  // synthetic-id mismatch) still surfaces, grouped at the end — never dropped.
  const orphans = children.filter((branch) => !attached.has(branch.sessionId));
  if (orphans.length > 0) {
    rows.push({ kind: "message", role: "system", text: "branches", depth: 0 });
    for (const branch of orphans) {
      const summary = branch.branchSummary ? ` — ${foldLabel(branch.branchSummary, foldWidth)}` : "";
      rows.push({
        kind: "branch",
        childSessionId: branch.sessionId,
        text: `branch: ${branch.title} (${branch.turnCount} turn${branch.turnCount === 1 ? "" : "s"})${summary}`,
        depth: 1
      });
    }
  }

  return { title: session.title, rows, forkTargets };
}

/** Plain-text render (non-TTY + tests). guru.ts colors the same rows for TTY. */
export function renderTreePlain(model: SessionTreeModel): string[] {
  const lines = [`Session tree · ${model.title}`];
  for (const row of model.rows) {
    const indent = "  ".repeat(row.depth + 1);
    if (row.kind === "branch") {
      lines.push(`${indent}└─ ${row.text}`);
      continue;
    }
    const marker = row.forkNumber !== undefined ? `[${row.forkNumber}]` : "   ";
    const who = row.role === "user" ? "you" : row.role === "assistant" ? "guru" : row.role ?? "";
    lines.push(`${indent}${marker} ${who ? `${who}: ` : ""}${row.text}`.trimEnd());
  }
  return lines;
}
