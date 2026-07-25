export interface DoneClaimEvidence {
  evidenceIds: readonly string[];
  skipReason?: string;
}

/** Returns whether a done claim is backed by evidence or an explicit exception. */
export function mayClaimDone({ evidenceIds, skipReason }: DoneClaimEvidence): boolean {
  return evidenceIds.length > 0 || (skipReason?.trim().length ?? 0) > 0;
}
