import { describe, expect, it } from "vitest";

import { blockWhen, evaluatePreCompact } from '../../src/compaction/preCompactGate.js';
import type { PreCompactContext } from '../../src/compaction/preCompactTypes.js';

const context: PreCompactContext = {
  tokensBefore: 12_000,
  firstKeptEntryId: "e42",
  reason: "threshold",
  compactCount: 2
};

const CHECKED_AT = "2026-07-19T06:27:06.000Z";

describe("evaluatePreCompact", () => {
  it("allows compaction by default and emits an allow receipt", () => {
    const result = evaluatePreCompact({ context, checkedAt: CHECKED_AT });

    expect(result).toEqual({
      decision: { action: "allow" },
      receipt: {
        decision: { action: "allow" },
        checkedAt: CHECKED_AT,
        blockingHooks: []
      }
    });
  });

  it("blocks when a configured hook observes an unparked-context flag", () => {
    let hasUnparkedCriticalContext = true;
    const result = evaluatePreCompact({
      config: {
        hooks: [blockWhen("unparked-context", () => hasUnparkedCriticalContext)]
      },
      context,
      checkedAt: CHECKED_AT
    });

    expect(result).toEqual({
      decision: {
        action: "block",
        blockReason: {
          category: "unparked-context",
          message: "Pre-compact gate blocked compaction (category: unparked-context)."
        }
      },
      receipt: {
        decision: {
          action: "block",
          blockReason: {
            category: "unparked-context",
            message: "Pre-compact gate blocked compaction (category: unparked-context)."
          }
        },
        checkedAt: CHECKED_AT,
        blockingHooks: ["unparked-context"]
      }
    });

    hasUnparkedCriticalContext = false;
  });

  it("records a veto without claiming the caller compacted or changed history", () => {
    const originalContext = structuredClone(context);
    const result = evaluatePreCompact({
      config: {
        hooks: [blockWhen("unparked-context", () => true)]
      },
      context,
      checkedAt: CHECKED_AT
    });

    expect(context).toEqual(originalContext);
    expect(result.receipt).toEqual({
      decision: result.decision,
      checkedAt: CHECKED_AT,
      blockingHooks: ["unparked-context"]
    });
    expect(result.receipt).not.toHaveProperty("compacted");
    expect(result.receipt).not.toHaveProperty("historyChanged");
  });
});
