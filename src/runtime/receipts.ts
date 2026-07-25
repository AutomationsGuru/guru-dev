/**
 * Tool/work receipts (IDEA-E3, 2026-07-18) — an in-memory, bounded store of
 * what tools actually did, keyed by (turnId, toolCallId), so a surface (TUI,
 * RPC, review) can inspect recent tool work WITHOUT replaying or flooding the
 * main transcript.
 *
 * Honesty is structural, not prose:
 *  - a receipt must carry a stable key at record time (blank ids throw);
 *  - summaries are truncated at record time, so no receipt can flood an inspector;
 *  - capacity is a hard-bounded ring — oldest receipts evict, never grow forever;
 *  - misses return undefined; the empty store renders "no receipts" — the store
 *    never fabricates a record or claims work that was not recorded.
 *
 * The store holds metadata (ids, status, timing, a bounded summary) — never raw
 * tool payloads. Recording callers pass an already-scrubbed summary; this module
 * enforces the size bound that keeps inspection cheap.
 */

export const RECEIPT_DEFAULT_CAPACITY = 128;
export const RECEIPT_CAPACITY_HARD_CAP = 4_096;
export const RECEIPT_SUMMARY_MAX_LENGTH = 200;

export type ToolReceiptStatus = "succeeded" | "failed";

export interface ToolReceipt {
  /** Turn the tool call belonged to. */
  readonly turnId: string;
  /** Provider/tool-call id within the turn — unique per (turnId, toolCallId). */
  readonly toolCallId: string;
  readonly toolId: string;
  readonly status: ToolReceiptStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** Bounded one-line description of the outcome (truncated at record time). */
  readonly summary: string;
}

export interface ReceiptListFilter {
  readonly turnId?: string;
}

export interface ReceiptStore {
  /** Record a receipt. Throws on a blank key; truncates overlong summaries. */
  record(receipt: ToolReceipt): void;
  /** Fetch one receipt by its stable key; undefined on an honest miss. */
  get(turnId: string, toolCallId: string): ToolReceipt | undefined;
  /** Most recent N receipts, newest first; optionally filtered to one turn. */
  list(lastN: number, filter?: ReceiptListFilter): readonly ToolReceipt[];
  /** Compact one-line-per-receipt rendering of the last N — transcript-free inspection. */
  render(lastN: number, filter?: ReceiptListFilter): string;
  readonly size: number;
}

export interface ReceiptStoreOptions {
  readonly capacity?: number;
}

function receiptKey(turnId: string, toolCallId: string): string {
  // Length-prefixed join: unambiguous for any id content — no separator collisions.
  return `${turnId.length}:${turnId}${toolCallId}`;
}

function truncateSummary(summary: string): string {
  return summary.length > RECEIPT_SUMMARY_MAX_LENGTH
    ? `${summary.slice(0, RECEIPT_SUMMARY_MAX_LENGTH - 1)}…`
    : summary;
}

export function createReceiptStore(options: ReceiptStoreOptions = {}): ReceiptStore {
  const capacity = options.capacity ?? RECEIPT_DEFAULT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > RECEIPT_CAPACITY_HARD_CAP) {
    throw new Error(`receipt store capacity must be an integer in [1, ${RECEIPT_CAPACITY_HARD_CAP}] — got ${options.capacity}`);
  }

  // Insertion-ordered ring: Map preserves insertion order, so eviction is
  // delete-oldest-key; re-recording an existing key refreshes in place.
  const byKey = new Map<string, ToolReceipt>();

  return {
    record(receipt) {
      if (receipt.turnId.trim().length === 0) {
        throw new Error("receipt requires a non-blank turnId — a receipt without a stable key is not inspectable");
      }
      if (receipt.toolCallId.trim().length === 0) {
        throw new Error("receipt requires a non-blank toolCallId — a receipt without a stable key is not inspectable");
      }
      const stored: ToolReceipt = { ...receipt, summary: truncateSummary(receipt.summary) };
      const key = receiptKey(stored.turnId, stored.toolCallId);
      byKey.delete(key); // refresh recency on re-record
      byKey.set(key, stored);
      while (byKey.size > capacity) {
        const oldest = byKey.keys().next();
        if (oldest.done) break;
        byKey.delete(oldest.value);
      }
    },

    get(turnId, toolCallId) {
      return byKey.get(receiptKey(turnId, toolCallId));
    },

    list(lastN, filter = {}) {
      if (!Number.isFinite(lastN) || lastN <= 0) {
        return [];
      }
      const all = [...byKey.values()];
      const filtered = filter.turnId === undefined ? all : all.filter((r) => r.turnId === filter.turnId);
      return filtered.slice(-Math.floor(lastN)).reverse();
    },

    render(lastN, filter = {}) {
      const receipts = this.list(lastN, filter);
      if (receipts.length === 0) {
        return filter.turnId === undefined ? "no receipts recorded" : `no receipts recorded for turn ${filter.turnId}`;
      }
      return receipts
        .map((r) => `${r.endedAt} ${r.status === "succeeded" ? "✓ succeeded" : "✗ failed"} ${r.toolId} [${r.turnId}/${r.toolCallId}] ${r.durationMs}ms — ${r.summary}`)
        .join("\n");
    },

    get size() {
      return byKey.size;
    }
  };
}
