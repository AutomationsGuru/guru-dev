import type { MemoryFactEntry } from "./policy.js";
import type { MemoryFactType } from "./schemas.js";

/**
 * Palace memory view (IDEA-F188-PALACE-VIEW-01; letta-code residual R-LT-PALACE).
 *
 * A read-only operator summary of the memory organ: every block on one line with
 * its type label, title, body size, and updatedAt — the "walk the palace" glance
 * a TUI/CLI surface renders so the operator can see what the harness remembers
 * without opening individual facts. Pure and provider-neutral: callers pass
 * `store.list()` output (Markdown L1 or PostgreSQL L2) and own sort order; this
 * module never touches the filesystem. Composes F174 (agent identity memory)
 * and F185 (doctor) as their display seam — it formats, it does not mutate.
 */

export interface PalaceBlockLine {
  readonly name: string;
  readonly title: string;
  readonly type: MemoryFactType;
  /** UTF-8 byte length of the block body (matches the store's size caps). */
  readonly bodyBytes: number;
  readonly updatedAt: string;
}

export interface PalaceViewSummary {
  readonly blockCount: number;
  readonly totalBodyBytes: number;
  readonly lines: readonly PalaceBlockLine[];
}

/** Structured form — the TUI renders rows from this; `formatView` is its text twin. */
export function summarizeBlocks(blocks: readonly MemoryFactEntry[]): PalaceViewSummary {
  const lines = blocks.map((entry) => ({
    name: entry.fact.name,
    title: entry.fact.title,
    type: entry.fact.type,
    bodyBytes: Buffer.byteLength(entry.body, "utf8"),
    updatedAt: entry.fact.updatedAt
  }));
  const totalBodyBytes = lines.reduce((total, line) => total + line.bodyBytes, 0);
  return { blockCount: lines.length, totalBodyBytes, lines };
}

/**
 * One string per block plus a header, joined by newlines:
 *   `N memory block(s), M B total`
 *   `- [type] title — bodyBytes B, updated <updatedAt>`
 * Caller order is preserved (recency sorting belongs to the store/caller).
 */
export function formatView(blocks: readonly MemoryFactEntry[]): string {
  const summary = summarizeBlocks(blocks);
  const plural = summary.blockCount === 1 ? "" : "s";
  const header = `${summary.blockCount} memory block${plural}, ${summary.totalBodyBytes} B total`;
  if (summary.lines.length === 0) {
    return header;
  }
  const rows = summary.lines.map((line) => `- [${line.type}] ${line.title} — ${line.bodyBytes} B, updated ${line.updatedAt}`);
  return [header, ...rows].join("\n");
}
