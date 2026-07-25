import {
  SessionGoalAmendmentSchema,
  SessionGoalDraftSchema,
  type SessionGoal,
  type SessionGoalAcceptanceCriterion,
  type SessionGoalAmendment,
  type SessionGoalDraft,
  type SessionGoalStatus
} from "./sessionGoalLifecycleSchema.js";

export interface SessionGoalLifecycleOptions {
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

const goalsBySessionId = new Map<string, SessionGoal[]>();
let goalSequence = 0;
let criterionSequence = 0;

function cloneGoal(goal: SessionGoal): SessionGoal {
  return {
    ...goal,
    acceptanceCriteria: goal.acceptanceCriteria.map((criterion) => ({ ...criterion }))
  };
}

function getSessionGoals(sessionId: string): SessionGoal[] {
  return goalsBySessionId.get(sessionId) ?? [];
}

function getLiveGoal(sessionId: string): SessionGoal | undefined {
  return getSessionGoals(sessionId).find((goal) => goal.status !== "completed");
}

function requireGoal(sessionId: string, goalId: string): SessionGoal {
  const goal = getSessionGoals(sessionId).find((candidate) => candidate.id === goalId);

  if (!goal) {
    throw new Error(`Session goal not found for session ${sessionId}: ${goalId}`);
  }

  return goal;
}

function storeGoal(goal: SessionGoal): void {
  const goals = goalsBySessionId.get(goal.sessionId);
  if (!goals) {
    goalsBySessionId.set(goal.sessionId, [goal]);
    return;
  }

  const index = goals.findIndex((candidate) => candidate.id === goal.id);
  if (index === -1) {
    goals.push(goal);
  } else {
    goals[index] = goal;
  }
}

function buildCriteria(texts: readonly string[]): SessionGoalAcceptanceCriterion[] {
  return texts.map((text) => {
    criterionSequence += 1;
    return { id: `criterion-${criterionSequence}`, text: text.trim(), accepted: false };
  });
}

function createGoal(draft: SessionGoalDraft, status: SessionGoalStatus, now: () => string): SessionGoal {
  const parsed = SessionGoalDraftSchema.safeParse(draft);

  if (!parsed.success) {
    throw new Error(
      `Invalid session goal draft: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  if (parsed.data.acceptanceCriteria.length === 0) {
    throw new Error("A session goal requires at least one acceptance criterion.");
  }

  if (getLiveGoal(parsed.data.sessionId)) {
    throw new Error(`Session ${parsed.data.sessionId} already has a goal; clear or complete it before creating another. Only one active goal is allowed per session.`);
  }

  const timestamp = now();
  goalSequence += 1;
  const goal: SessionGoal = {
    id: `goal-${goalSequence}`,
    sessionId: parsed.data.sessionId,
    objective: parsed.data.objective,
    acceptanceCriteria: buildCriteria(parsed.data.acceptanceCriteria),
    status,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  storeGoal(goal);
  return cloneGoal(goal);
}

export function createSessionGoal(draft: SessionGoalDraft, options?: SessionGoalLifecycleOptions): SessionGoal {
  return createGoal(draft, "active", options?.now ?? defaultNow);
}

export function proposeSessionGoal(draft: SessionGoalDraft, options?: SessionGoalLifecycleOptions): SessionGoal {
  return createGoal(draft, "paused", options?.now ?? defaultNow);
}

export function getActiveSessionGoal(sessionId: string): SessionGoal | undefined {
  const goal = getSessionGoals(sessionId).find((candidate) => candidate.status === "active");
  return goal ? cloneGoal(goal) : undefined;
}

export function getSessionGoal(sessionId: string, goalId: string): SessionGoal {
  return cloneGoal(requireGoal(sessionId, goalId));
}

function assertNotCompleted(goal: SessionGoal, action: string): void {
  if (goal.status === "completed") {
    throw new Error(`Cannot ${action} a completed session goal.`);
  }
}

export function acceptSessionGoalCriteria(
  sessionId: string,
  goalId: string,
  options?: SessionGoalLifecycleOptions
): SessionGoal {
  const goal = requireGoal(sessionId, goalId);
  assertNotCompleted(goal, "accept criteria on");

  const updated: SessionGoal = {
    ...goal,
    acceptanceCriteria: goal.acceptanceCriteria.map((criterion) => ({ ...criterion, accepted: true })),
    updatedAt: (options?.now ?? defaultNow)()
  };

  storeGoal(updated);
  return cloneGoal(updated);
}

export function amendSessionGoal(
  sessionId: string,
  goalId: string,
  amendment: SessionGoalAmendment,
  options?: SessionGoalLifecycleOptions
): SessionGoal {
  const goal = requireGoal(sessionId, goalId);
  assertNotCompleted(goal, "amend");

  const parsed = SessionGoalAmendmentSchema.safeParse(amendment);
  if (!parsed.success) {
    throw new Error(
      `Invalid session goal amendment: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  const next: SessionGoal = {
    ...goal,
    updatedAt: (options?.now ?? defaultNow)()
  };

  if (parsed.data.objective !== undefined) {
    next.objective = parsed.data.objective;
  }

  if (parsed.data.acceptanceCriteria !== undefined) {
    const acceptedTexts = new Map(goal.acceptanceCriteria.map((criterion) => [criterion.text, criterion.accepted]));
    next.acceptanceCriteria = parsed.data.acceptanceCriteria.map((text) => {
      const trimmed = text.trim();
      const priorAccepted = acceptedTexts.get(trimmed);
      criterionSequence += 1;
      return { id: `criterion-${criterionSequence}`, text: trimmed, accepted: priorAccepted ?? false };
    });
  }

  if (parsed.data.status !== undefined) {
    next.status = parsed.data.status;
  }

  storeGoal(next);
  return cloneGoal(next);
}

export function pauseSessionGoal(
  sessionId: string,
  goalId: string,
  options?: SessionGoalLifecycleOptions
): SessionGoal {
  const goal = requireGoal(sessionId, goalId);
  assertNotCompleted(goal, "pause");

  if (goal.status !== "active") {
    throw new Error(`Cannot pause a session goal in status ${goal.status}; only an active goal can be paused.`);
  }

  const updated: SessionGoal = { ...goal, status: "paused", updatedAt: (options?.now ?? defaultNow)() };
  storeGoal(updated);
  return cloneGoal(updated);
}

export function resumeSessionGoal(
  sessionId: string,
  goalId: string,
  options?: SessionGoalLifecycleOptions
): SessionGoal {
  const goal = requireGoal(sessionId, goalId);

  if (goal.status !== "paused") {
    throw new Error(`Cannot resume a session goal in status ${goal.status}; only a paused goal can be resumed.`);
  }

  const updated: SessionGoal = { ...goal, status: "active", updatedAt: (options?.now ?? defaultNow)() };
  storeGoal(updated);
  return cloneGoal(updated);
}

export function completeSessionGoal(
  sessionId: string,
  goalId: string,
  options?: SessionGoalLifecycleOptions
): SessionGoal {
  const goal = requireGoal(sessionId, goalId);

  if (goal.status === "completed") {
    throw new Error("Cannot complete a session goal that is already completed.");
  }

  const updated: SessionGoal = { ...goal, status: "completed", updatedAt: (options?.now ?? defaultNow)() };
  storeGoal(updated);
  return cloneGoal(updated);
}

export function clearSessionGoal(sessionId: string): void {
  goalsBySessionId.delete(sessionId);
}
