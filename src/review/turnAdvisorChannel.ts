export type AdvisorSeverity = "concern" | "blocker";

export interface AdvisorNote {
  readonly severity: AdvisorSeverity;
  readonly text: string;
}

export interface AppliedAdvisorNote extends AdvisorNote {
  /** Advisory signal only; callers retain all stop, approval, and mutation authority. */
  readonly stopRecommended: boolean;
}

/**
 * Normalize an advisor note for the completed-turn channel without taking any action.
 * A blocker may recommend stopping, but this adapter cannot stop, ship, approve, issue
 * review verdicts, or mutate state.
 */
export function applyAdvisor(note: AdvisorNote): AppliedAdvisorNote {
  return {
    severity: note.severity,
    text: note.text.trim(),
    stopRecommended: note.severity === "blocker"
  };
}
