export type GroundedAnswerMode = "grounded";
export type GroundedAnswerStep = "gather" | "present";

export interface GroundedAnswerPhase {
  readonly canCallTools: boolean;
  readonly canEmitUserText: boolean;
}

const GATHER_PHASE: GroundedAnswerPhase = Object.freeze({
  canCallTools: true,
  canEmitUserText: false
});

const PRESENT_PHASE: GroundedAnswerPhase = Object.freeze({
  canCallTools: false,
  canEmitUserText: true
});

/**
 * Returns the structural capabilities for a grounded-answer step.
 *
 * Gathering is tool-only: it can collect evidence but cannot produce the
 * user-facing response. Presenting is the complementary capability: it can
 * emit the response but cannot call tools.
 */
export function phaseFor(mode: GroundedAnswerMode, step: GroundedAnswerStep): GroundedAnswerPhase {
  if (mode !== "grounded") {
    throw new Error(`Unsupported grounded-answer mode: ${mode}`);
  }

  return step === "gather" ? GATHER_PHASE : PRESENT_PHASE;
}
