import { describe, expect, it } from "vitest";

import {
  canCloseBug,
  DEBUG_PHASE_ORDER,
  DebugPhase,
  type DebugPhaseReceipt,
  missingPhasesForClose
} from '../../src/session/systematicDebugPhases.js';

function receipt(phase: DebugPhase, over: Partial<DebugPhaseReceipt> = {}): DebugPhaseReceipt {
  return { phase, evidence: "stub-evidence", ...over };
}

describe("systematicDebugPhases", () => {
  describe("DEBUG_PHASE_ORDER", () => {
    it("defines the canonical ordered debug phases repro -> isolate -> fix -> verify", () => {
      expect(DEBUG_PHASE_ORDER).toEqual([
        DebugPhase.Repro,
        DebugPhase.Isolate,
        DebugPhase.Fix,
        DebugPhase.Verify
      ]);
    });
  });

  describe("canCloseBug", () => {
    it("allows close when all four phases are present in order", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(true);
    });

    it("rejects an empty receipt set", () => {
      expect(canCloseBug([])).toBe(false);
    });

    it("rejects when the Repro phase is missing", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("rejects when the Isolate phase is missing", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("rejects when the Fix phase is missing", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("rejects when the Verify phase is missing", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("rejects when phases are present but out of order (verify before fix)", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Verify),
        receipt(DebugPhase.Fix)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("rejects when an early phase follows a later phase (isolate before repro)", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("rejects a receipt missing required evidence", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro, { evidence: "" }),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("ignores non-debug receipts (unknown phases do not satisfy any phase)", () => {
      const receipts = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix),
        { phase: "brainstorm" as DebugPhase, evidence: "x" }
      ];
      expect(canCloseBug(receipts)).toBe(false);
    });

    it("accepts a superset that still respects order (extra repro re-runs allowed)", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(canCloseBug(receipts)).toBe(true);
    });
  });

  describe("missingPhasesForClose", () => {
    it("returns all four phases when empty", () => {
      expect(missingPhasesForClose([])).toEqual(DEBUG_PHASE_ORDER);
    });

    it("returns the empty set when a complete ordered chain is present", () => {
      const receipts: DebugPhaseReceipt[] = [
        receipt(DebugPhase.Repro),
        receipt(DebugPhase.Isolate),
        receipt(DebugPhase.Fix),
        receipt(DebugPhase.Verify)
      ];
      expect(missingPhasesForClose(receipts)).toEqual([]);
    });

    it("reports remaining phases when only repro is present", () => {
      expect(missingPhasesForClose([receipt(DebugPhase.Repro)])).toEqual([
        DebugPhase.Isolate,
        DebugPhase.Fix,
        DebugPhase.Verify
      ]);
    });

    it("does not advance past a missing phase even if later phases appear", () => {
      // Fix appears but Isolate has not: Isolate, Fix, Verify all still missing
      // because the chain cannot advance past Isolate.
      expect(missingPhasesForClose([receipt(DebugPhase.Repro), receipt(DebugPhase.Fix)])).toEqual([
        DebugPhase.Isolate,
        DebugPhase.Fix,
        DebugPhase.Verify
      ]);
    });
  });
});
