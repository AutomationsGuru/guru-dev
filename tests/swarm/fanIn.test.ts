import { describe, expect, it } from "vitest";

import { fanIn, FanInBlockedError, type WorkerReceipt } from '../../src/swarm/fanIn.js';

const receipt = (overrides: Partial<WorkerReceipt> = {}): WorkerReceipt => ({
  workerId: "w1",
  role: "builder",
  status: "done",
  artifactRefs: ["diff://w1/1"],
  summary: "built the thing",
  ...overrides
});

describe("fanIn — aggregate", () => {
  it("aggregates every receipt into an ordered bundle", () => {
    const result = fanIn({ fanInRequired: false, receipts: [receipt({ workerId: "w1" }), receipt({ workerId: "w2" })] });
    expect(result.aggregate.receipts).toHaveLength(2);
    expect(result.aggregate.receipts.map((entry) => entry.workerId)).toEqual(["w1", "w2"]);
  });

  it("counts outcomes across the receipts", () => {
    const result = fanIn({
      fanInRequired: false,
      receipts: [receipt({ status: "done" }), receipt({ workerId: "w2", status: "failed" }), receipt({ workerId: "w3", status: "done" })]
    });
    expect(result.aggregate.done).toBe(2);
    expect(result.aggregate.failed).toBe(1);
  });
});

describe("fanIn — verify", () => {
  it("flags receipts that produced no artifact (dispatch is not done)", () => {
    const result = fanIn({ fanInRequired: false, receipts: [receipt({ artifactRefs: [] })] });
    expect(result.verify.missingArtifacts).toEqual(["w1"]);
    expect(result.verify.ok).toBe(false);
  });

  it("passes verification when every done worker left an artifact", () => {
    const result = fanIn({ fanInRequired: false, receipts: [receipt({ workerId: "w1" }), receipt({ workerId: "w2" })] });
    expect(result.verify.ok).toBe(true);
    expect(result.verify.missingArtifacts).toEqual([]);
  });
});

describe("fanIn — manager owns synthesis when fan_in_required", () => {
  it("blocks parent completion until a synthesis artifact is supplied", () => {
    expect(() => fanIn({ fanInRequired: true, receipts: [receipt()] })).toThrow(FanInBlockedError);
  });

  it("produces a synthesis artifact via the injected synthesizer and marks the parent complete", () => {
    const result = fanIn({
      fanInRequired: true,
      receipts: [receipt({ workerId: "w1" }), receipt({ workerId: "w2" })],
      synthesize: (bundle) => `combined ${bundle.receipts.length} answers into one`
    });
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis!.text).toContain("combined 2 answers");
    expect(result.parentComplete).toBe(true);
  });

  it("records the synthesis as an artifact ref the parent can cite", () => {
    const result = fanIn({
      fanInRequired: true,
      receipts: [receipt()],
      synthesize: () => "one answer"
    });
    expect(result.synthesis!.artifactRef).toMatch(/^synthesis:\/\//);
  });

  it("the synthesizer receives the aggregated + verified bundle (manager has the full picture)", () => {
    let seen: { receipts: readonly unknown[] } | undefined;
    fanIn({
      fanInRequired: true,
      receipts: [receipt({ workerId: "w1" }), receipt({ workerId: "w2" })],
      synthesize: (bundle) => {
        seen = bundle;
        return "ok";
      }
    });
    expect(seen?.receipts).toHaveLength(2);
  });
});

describe("fanIn — fan_in_required=false (no combined answer needed)", () => {
  it("completes the parent without a synthesis artifact", () => {
    const result = fanIn({ fanInRequired: false, receipts: [receipt()] });
    expect(result.synthesis).toBeUndefined();
    expect(result.parentComplete).toBe(true);
  });
});

describe("fanIn — failure propagation", () => {
  it("does not mark the parent complete when any worker failed and fan-in is required, even with a synthesizer", () => {
    const result = fanIn({
      fanInRequired: true,
      receipts: [receipt({ status: "done" }), receipt({ workerId: "w2", status: "failed", failureClass: "task" })],
      synthesize: () => "partial"
    });
    expect(result.parentComplete).toBe(false);
    expect(result.verify.ok).toBe(false);
  });
});
