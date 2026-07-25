/**
 * Completion Verification Gate — IDEA-F327-VERIFY-01
 *
 * claimComplete requires verification receipt (command/tests) or an explicit
 * skip with a non-empty reason string. Silent success and bare claims without
 * evidence are rejected.
 */

export interface VerificationResult {
  /** Exit code of the verification command (0 = pass). */
  readonly exitCode: number;
  /** Optional captured output from the verification run. */
  readonly output?: string;
}

export interface ClaimCompleteInput {
  /**
   * A verification receipt from running a command or test suite.
   * When present, exitCode 0 means the task is verified.
   */
  readonly verification?: VerificationResult;
  /**
   * An explicit reason why verification was skipped.
   * Must be non-empty after trimming to count as a valid skip.
   */
  readonly skipReason?: string;
}

/**
 * Returns true when the claim is substantiated: either a verification passed
 * (exitCode 0) or an explicit, non-empty skip reason was given.
 *
 * A bare claim (no verification AND no skip reason, or an empty/whitespace-only
 * skip reason) returns false.
 */
export function canClaimComplete(input: ClaimCompleteInput): boolean {
  if (input.verification) {
    return input.verification.exitCode === 0;
  }
  if (typeof input.skipReason === "string" && input.skipReason.trim().length > 0) {
    return true;
  }
  return false;
}
