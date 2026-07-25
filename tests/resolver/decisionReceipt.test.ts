import { describe, expect, it } from "vitest";

import { appendDecision, createEmptyStore, listOpenDecisions } from '../../src/resolver/decisionReceipt.js';
import type { DecisionReceiptStore } from '../../src/resolver/decisionReceiptSchema.js';

function freshStore(): DecisionReceiptStore {
  return createEmptyStore();
}

const VALID_INPUT = {
  gap: "fetch a web page",
  move: "build" as const,
  statement: "I'll BUILD a native HTTP tool.",
  reasons: ["no attachable command on PATH", "building keeps it owned"],
  workPlan: ["Design the tool schema", "Implement + test", "Register through extension seam"],
  evidence: ["PATH: curl absent", "PATH: wget absent"]
};

describe("appendDecision", () => {
  it("appends a valid decision receipt and returns it", () => {
    const store = freshStore();
    const receipt = appendDecision(store, VALID_INPUT);

    expect(receipt.id).toBeTypeOf("string");
    expect(receipt.createdAt).toBeTypeOf("string");
    expect(receipt.gap).toBe("fetch a web page");
    expect(receipt.move).toBe("build");
    expect(receipt.statement).toBe("I'll BUILD a native HTTP tool.");
    expect(receipt.reasons).toEqual(VALID_INPUT.reasons);
    expect(receipt.workPlan).toEqual(VALID_INPUT.workPlan);
    expect(receipt.evidence).toEqual(VALID_INPUT.evidence);
    expect(receipt.status).toBe("open");
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]).toEqual(receipt);
  });

  it("accepts all four valid moves", () => {
    const moves = ["already-have", "attach", "learn-replicate", "build"] as const;
    for (const move of moves) {
      const store = freshStore();
      const receipt = appendDecision(store, { ...VALID_INPUT, move });
      expect(receipt.move).toBe(move);
      expect(receipt.status).toBe("open");
    }
  });

  it("refuses an empty move string (zod validation)", () => {
    const store = freshStore();
    expect(() =>
      appendDecision(store, { ...VALID_INPUT, move: "" as any })
    ).toThrow();
    // Store must not be mutated on failure.
    expect(store.decisions).toHaveLength(0);
  });

  it("refuses an invalid move string (zod validation)", () => {
    const store = freshStore();
    expect(() =>
      appendDecision(store, { ...VALID_INPUT, move: "invent-something" as any })
    ).toThrow();
    expect(store.decisions).toHaveLength(0);
  });

  it("refuses an empty gap", () => {
    const store = freshStore();
    expect(() =>
      appendDecision(store, { ...VALID_INPUT, gap: "" })
    ).toThrow();
    expect(store.decisions).toHaveLength(0);
  });

  it("refuses an empty statement", () => {
    const store = freshStore();
    expect(() =>
      appendDecision(store, { ...VALID_INPUT, statement: "" })
    ).toThrow();
    expect(store.decisions).toHaveLength(0);
  });

  it("records an ATTACH decision with an explicit nextCheckAt for provisional re-evaluation", () => {
    const store = freshStore();
    const nextCheck = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const receipt = appendDecision(store, {
      ...VALID_INPUT,
      move: "attach",
      statement: "I'll ATTACH: curl is already on this machine.",
      nextCheckAt: nextCheck
    });

    expect(receipt.move).toBe("attach");
    expect(receipt.nextCheckAt).toBe(nextCheck);
    expect(receipt.status).toBe("open");
  });

  it("generates a unique UUID id for every receipt", () => {
    const store = freshStore();
    const a = appendDecision(store, VALID_INPUT);
    const b = appendDecision(store, { ...VALID_INPUT, gap: "send a Slack message" });
    expect(a.id).not.toBe(b.id);
    expect(store.decisions).toHaveLength(2);
  });
});

describe("listOpenDecisions", () => {
  it("returns only open decisions", () => {
    const store = freshStore();
    const r1 = appendDecision(store, VALID_INPUT);
    const r2 = appendDecision(store, { ...VALID_INPUT, gap: "send a Slack message" });

    // Close r2 manually (simulate resolution).
    (r2 as any).status = "closed";

    const open = listOpenDecisions(store);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(r1.id);
  });

  it("filters open decisions by move", () => {
    const store = freshStore();
    appendDecision(store, { ...VALID_INPUT, move: "build", gap: "gap A" });
    appendDecision(store, { ...VALID_INPUT, move: "attach", gap: "gap B" });
    appendDecision(store, { ...VALID_INPUT, move: "build", gap: "gap C" });

    const builds = listOpenDecisions(store, { move: "build" });
    expect(builds).toHaveLength(2);
    expect(builds.map(d => d.gap)).toEqual(["gap A", "gap C"]);

    const attaches = listOpenDecisions(store, { move: "attach" });
    expect(attaches).toHaveLength(1);
    expect(attaches[0]!.gap).toBe("gap B");

    const learns = listOpenDecisions(store, { move: "learn-replicate" });
    expect(learns).toHaveLength(0);
  });

  it("returns all open decisions when no filter is given", () => {
    const store = freshStore();
    appendDecision(store, { ...VALID_INPUT, gap: "gap A" });
    appendDecision(store, { ...VALID_INPUT, gap: "gap B" });
    appendDecision(store, { ...VALID_INPUT, gap: "gap C" });

    expect(listOpenDecisions(store)).toHaveLength(3);
  });

  it("returns empty array for an empty store", () => {
    expect(listOpenDecisions(freshStore())).toEqual([]);
  });
});
