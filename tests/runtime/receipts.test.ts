import { describe, expect, it } from "vitest";

import {
  RECEIPT_CAPACITY_HARD_CAP,
  createReceiptStore,
  type ToolReceipt
} from '../../src/runtime/receipts.js';

function receipt(overrides: Partial<ToolReceipt> = {}): ToolReceipt {
  return {
    turnId: "turn-1",
    toolCallId: "call-1",
    toolId: "read_file",
    status: "succeeded",
    startedAt: "2026-07-18T00:00:00.000Z",
    endedAt: "2026-07-18T00:00:00.250Z",
    durationMs: 250,
    summary: "read 12 lines",
    ...overrides
  };
}

describe("receipt store — keyed by turn/tool id", () => {
  it("records and fetches a receipt by (turnId, toolCallId)", () => {
    const store = createReceiptStore();
    store.record(receipt());
    const found = store.get("turn-1", "call-1");
    expect(found?.toolId).toBe("read_file");
    expect(found?.status).toBe("succeeded");
  });

  it("same toolCallId under a different turn is a different receipt", () => {
    const store = createReceiptStore();
    store.record(receipt({ turnId: "turn-1", toolCallId: "call-1", summary: "first" }));
    store.record(receipt({ turnId: "turn-2", toolCallId: "call-1", summary: "second" }));
    expect(store.get("turn-1", "call-1")?.summary).toBe("first");
    expect(store.get("turn-2", "call-1")?.summary).toBe("second");
    expect(store.size).toBe(2);
  });

  it("misses honestly — unknown keys return undefined, never a fabricated receipt", () => {
    const store = createReceiptStore();
    expect(store.get("turn-nope", "call-nope")).toBeUndefined();
  });

  it("rejects a receipt without a stable key (blank turn/toolCall id)", () => {
    const store = createReceiptStore();
    expect(() => store.record(receipt({ turnId: " " }))).toThrow(/turnId/);
    expect(() => store.record(receipt({ toolCallId: "" }))).toThrow(/toolCallId/);
  });
});

describe("receipt store — list last N for inspection without the transcript", () => {
  it("lists the most recent N in newest-first order", () => {
    const store = createReceiptStore();
    for (let i = 1; i <= 5; i += 1) {
      store.record(receipt({ toolCallId: `call-${i}`, summary: `step ${i}` }));
    }
    const last2 = store.list(2);
    expect(last2.map((r) => r.toolCallId)).toEqual(["call-5", "call-4"]);
  });

  it("list(0) and negative N return nothing; N larger than the store returns everything", () => {
    const store = createReceiptStore();
    store.record(receipt());
    expect(store.list(0)).toEqual([]);
    expect(store.list(-3)).toEqual([]);
    expect(store.list(99)).toHaveLength(1);
  });

  it("lists can be filtered to a single turn", () => {
    const store = createReceiptStore();
    store.record(receipt({ turnId: "turn-1", toolCallId: "call-1" }));
    store.record(receipt({ turnId: "turn-2", toolCallId: "call-2" }));
    store.record(receipt({ turnId: "turn-1", toolCallId: "call-3" }));
    expect(store.list(10, { turnId: "turn-1" }).map((r) => r.toolCallId)).toEqual(["call-3", "call-1"]);
  });
});

describe("receipt store — bounded capacity (structural, not prose)", () => {
  it("evicts oldest past capacity; default capacity is bounded", () => {
    const store = createReceiptStore({ capacity: 3 });
    for (let i = 1; i <= 5; i += 1) {
      store.record(receipt({ toolCallId: `call-${i}` }));
    }
    expect(store.size).toBe(3);
    expect(store.get("turn-1", "call-1")).toBeUndefined();
    expect(store.get("turn-1", "call-5")).toBeDefined();
  });

  it("capacity cannot exceed the hard cap", () => {
    expect(() => createReceiptStore({ capacity: RECEIPT_CAPACITY_HARD_CAP + 1 })).toThrow(/capacity/i);
    expect(() => createReceiptStore({ capacity: 0 })).toThrow(/capacity/i);
  });
});

describe("receipt store — inspectable rendering that cannot flood", () => {
  it("renders compact one-line-per-receipt output for the last N", () => {
    const store = createReceiptStore();
    store.record(receipt({ toolCallId: "call-1", summary: "read 12 lines" }));
    store.record(receipt({ toolCallId: "call-2", toolId: "bash", status: "failed", summary: "exit 1" }));
    const rendered = store.render(5);
    const lines = rendered.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("failed");
  });

  it("renders an honest empty state instead of claiming receipts exist", () => {
    const store = createReceiptStore();
    expect(store.render(5)).toMatch(/no receipts/i);
  });

  it("overlong summaries are truncated at record time — a receipt can never flood the inspector", () => {
    const store = createReceiptStore();
    store.record(receipt({ summary: "s".repeat(10_000) }));
    const found = store.get("turn-1", "call-1");
    expect(found?.summary.length).toBeLessThanOrEqual(200);
    expect(found?.summary).toMatch(/…$/);
  });
});
