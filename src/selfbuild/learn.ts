import type { StageVerdict } from "./devCycle.js";

/**
 * LEARN write-back (self-build P4) — after a cycle, derive ONE validated fact from the
 * outcome. A clean GREEN completion is `validated`; anything softer (YELLOW, or a blocked
 * cycle) is `parked` — recorded, but not asserted as known-good. A blocked cycle's fact
 * carries the blocker note so the next SELECT can deprioritise that task (the feedback arc).
 */

export interface LearnedFact {
  readonly taskId: string;
  readonly outcome: "shipped" | "blocked";
  readonly verdict: StageVerdict;
  readonly confidence: "validated" | "parked";
  readonly fact: string;
  readonly blockerNote?: string;
}

export function deriveLearning(input: {
  readonly taskId: string;
  readonly terminal: "done" | "blocked";
  readonly verdict: StageVerdict;
  readonly note?: string;
}): LearnedFact {
  const shipped = input.terminal === "done";
  const suffix = input.note ? ` — ${input.note}` : "";
  return {
    taskId: input.taskId,
    outcome: shipped ? "shipped" : "blocked",
    verdict: input.verdict,
    confidence: shipped && input.verdict === "GREEN" ? "validated" : "parked",
    fact: `task ${input.taskId} ${shipped ? "completed" : "blocked"} (${input.verdict})${suffix}`,
    ...(shipped ? {} : { blockerNote: input.note ?? "unknown" })
  };
}
