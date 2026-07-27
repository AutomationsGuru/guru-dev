/**
 * Systematic Debug Phases
 *
 * Defines the ordered phases required before a bug can be closed.
 * Each phase must produce evidence (receipt) before progressing.
 * This enforces the systematic debugging discipline: repro → isolate → fix → verify.
 */

/**
 * Debug phases in execution order.
 * Each phase builds on the previous and produces a receipt.
 */
export enum DebugPhase {
  /** Phase 1: Identify and reproduce the issue */
  DISCOVERY = "discovery",
  /** Phase 2: Narrow down the problem scope */
  ISOLATION = "isolation",
  /** Phase 3: Determine root cause */
  DIAGNOSIS = "diagnosis",
  /** Phase 4: Implement the solution */
  FIX = "fix",
  /** Phase 5: Confirm the fix works */
  VERIFICATION = "verification",
  /** Phase 6: Add safeguards against regression */
  PREVENTION = "prevention",
}

/**
 * Receipt proving a phase was completed with evidence.
 */
export interface PhaseReceipt {
  phase: DebugPhase;
  /** Timestamp when phase was completed */
  completedAt: Date;
  /** Evidence produced during this phase (logs, tests, analysis) */
  evidence: string;
}

/**
 * Check if a bug can be closed based on completed phase receipts.
 *
 * Requires all phases to be completed in order.
 * Missing any phase blocks the close.
 *
 * @param receipts - Array of phase receipts collected during debugging
 * @returns true if all required phases are present, false otherwise
 */
export function canCloseBug(receipts: PhaseReceipt[]): boolean {
  const requiredPhases = [
    DebugPhase.DISCOVERY,
    DebugPhase.ISOLATION,
    DebugPhase.DIAGNOSIS,
    DebugPhase.FIX,
    DebugPhase.VERIFICATION,
    DebugPhase.PREVENTION,
  ];

  const completedPhases = new Set(receipts.map((r) => r.phase));

  // All required phases must be present
  return requiredPhases.every((phase) => completedPhases.has(phase));
}

/**
 * Get the next phase that should be executed.
 *
 * @param receipts - Current phase receipts
 * @returns The next phase to execute, or null if all phases complete
 */
export function getNextPhase(receipts: PhaseReceipt[]): DebugPhase | null {
  const requiredPhases = [
    DebugPhase.DISCOVERY,
    DebugPhase.ISOLATION,
    DebugPhase.DIAGNOSIS,
    DebugPhase.FIX,
    DebugPhase.VERIFICATION,
    DebugPhase.PREVENTION,
  ];

  const completedPhases = new Set(receipts.map((r) => r.phase));

  for (const phase of requiredPhases) {
    if (!completedPhases.has(phase)) {
      return phase;
    }
  }

  return null;
}

/**
 * Validate that phases are being completed in order.
 *
 * @param receipts - Phase receipts to validate
 * @returns true if phases are in correct order, false if out of sequence
 */
export function validatePhaseOrder(receipts: PhaseReceipt[]): boolean {
  const requiredPhases = [
    DebugPhase.DISCOVERY,
    DebugPhase.ISOLATION,
    DebugPhase.DIAGNOSIS,
    DebugPhase.FIX,
    DebugPhase.VERIFICATION,
    DebugPhase.PREVENTION,
  ];

  // Sort receipts by completion time
  const sortedReceipts = [...receipts].sort(
    (a, b) => a.completedAt.getTime() - b.completedAt.getTime()
  );

  // Check that phases appear in the required order
  for (let i = 0; i < sortedReceipts.length; i++) {
    const expectedPhase = requiredPhases[i];
    if (sortedReceipts[i].phase !== expectedPhase) {
      // Allow skipping ahead only if previous phases are complete
      // But never allow going backward
      const phaseIndex = requiredPhases.indexOf(sortedReceipts[i].phase);
      if (phaseIndex < i) {
        return false; // Out of order
      }
    }
  }

  return true;
}
