/** A timestamped claim or receipt recorded during an implementation workflow. */
export interface TddEnforceRecord {
  readonly recordedAt: string;
}

/** Inputs required to decide whether an implementation step may proceed. */
export interface TddEnforceModeInput {
  readonly enabled: boolean;
  /** The most recent production-edit claim, when production code was already changed. */
  readonly lastProductionEditClaim?: TddEnforceRecord;
  /** Evidence that a test failed before the next production edit. */
  readonly failingTestReceipt?: TddEnforceRecord;
}

export type TddEnforceModeOutcome = "allow" | "deny";

export interface TddEnforceModeDecision {
  readonly outcome: TddEnforceModeOutcome;
  readonly reason: string;
}

function recordedTime(record: TddEnforceRecord): number | undefined {
  const timestamp = Date.parse(record.recordedAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Enforces the red-before-production-edit TDD rule when the optional mode is on.
 * A receipt must be present and strictly newer than the last production edit claim.
 */
export function evaluateTddEnforceMode(input: TddEnforceModeInput): TddEnforceModeDecision {
  if (!input.enabled) {
    return { outcome: "allow", reason: "TDD enforce mode is off" };
  }

  if (!input.failingTestReceipt) {
    return { outcome: "deny", reason: "TDD enforce mode requires a failing-test receipt before a production edit" };
  }

  const receiptTime = recordedTime(input.failingTestReceipt);
  if (receiptTime === undefined) {
    return { outcome: "deny", reason: "failing-test receipt has an invalid recordedAt timestamp" };
  }

  if (!input.lastProductionEditClaim) {
    return { outcome: "allow", reason: "recorded failing-test receipt is present" };
  }

  const productionEditTime = recordedTime(input.lastProductionEditClaim);
  if (productionEditTime === undefined) {
    return { outcome: "deny", reason: "last production-edit claim has an invalid recordedAt timestamp" };
  }

  if (receiptTime <= productionEditTime) {
    return { outcome: "deny", reason: "failing-test receipt must be newer than the last production-edit claim" };
  }

  return { outcome: "allow", reason: "failing-test receipt is newer than the last production-edit claim" };
}
