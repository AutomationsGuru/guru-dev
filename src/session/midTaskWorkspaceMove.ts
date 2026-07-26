/**
 * Mid-task workspace move — pure relocation state machine.
 *
 * Marks a session as relocating, preserves the worktreePath in a snapshot,
 * and gates completion so callers cannot resume work at the old path.
 * No actual filesystem moves; this is state logic only.
 *
 * IDEA-F476-MOVE-01 — owned by the Linux builder lane.
 */

/** Discriminated phases of a workspace relocation. */
export type MovePhase = "active" | "relocating" | "relocated";

/** Immutable snapshot of a workspace relocation in progress or completed. */
export interface WorkspaceMoveState {
  readonly phase: MovePhase;
  /** The current workspace path (pre-move or post-move, depending on phase). */
  readonly worktreePath: string;
  /** Snapshot of the original path, captured when beginMove was called. */
  readonly originalPath: string | null;
  /** The target path supplied to beginMove. */
  readonly targetPath: string | null;
  /** ISO-8601 timestamp recorded when completeMove finishes. */
  readonly relocatedAt: string | null;
}

/**
 * Create a fresh move state for a session that has never been relocated.
 * The session starts active at its initial worktree path.
 */
export function createMoveState(worktreePath: string): WorkspaceMoveState {
  return {
    phase: "active",
    worktreePath,
    originalPath: null,
    targetPath: null,
    relocatedAt: null,
  };
}

/** Error thrown when a move transition is attempted from the wrong phase. */
export class MidTaskMovePhaseError extends Error {
  constructor(
    message: string,
    public readonly currentPhase: MovePhase,
    public readonly attemptedTransition: string,
  ) {
    super(message);
    this.name = "MidTaskMovePhaseError";
  }
}

/**
 * Begin a workspace move: snapshot the current path and transition to
 * `relocating`. Callers must not submit work while the session is in this
 * phase — the harness is paused until `completeMove` finishes.
 *
 * @throws {MidTaskMovePhaseError} if the session is not `active`.
 */
export function beginMove(
  state: WorkspaceMoveState,
  targetPath: string,
  now: () => Date = () => new Date(),
): WorkspaceMoveState {
  if (state.phase !== "active") {
    throw new MidTaskMovePhaseError(
      `Cannot begin workspace move: session phase is "${state.phase}" (expected "active").`,
      state.phase,
      "beginMove",
    );
  }
  if (!targetPath || targetPath.trim().length === 0) {
    throw new MidTaskMovePhaseError(
      "Cannot begin workspace move: targetPath must be a non-empty string.",
      state.phase,
      "beginMove",
    );
  }
  return {
    phase: "relocating",
    worktreePath: state.worktreePath, // preserved until move completes
    originalPath: state.worktreePath,
    targetPath: targetPath.trim(),
    relocatedAt: null,
  };
}

/**
 * Complete a workspace move: switch to the new path and transition to
 * `relocated`. After this call the session's worktreePath reflects the
 * new location and `originalPath` holds the pre-move snapshot.
 *
 * @throws {MidTaskMovePhaseError} if the session is not `relocating`.
 */
export function completeMove(
  state: WorkspaceMoveState,
  newWorktreePath: string,
  now: () => Date = () => new Date(),
): WorkspaceMoveState {
  if (state.phase !== "relocating") {
    throw new MidTaskMovePhaseError(
      `Cannot complete workspace move: session phase is "${state.phase}" (expected "relocating").`,
      state.phase,
      "completeMove",
    );
  }
  if (!newWorktreePath || newWorktreePath.trim().length === 0) {
    throw new MidTaskMovePhaseError(
      "Cannot complete workspace move: newWorktreePath must be a non-empty string.",
      state.phase,
      "completeMove",
    );
  }
  return {
    phase: "relocated",
    worktreePath: newWorktreePath.trim(),
    originalPath: state.originalPath,
    targetPath: state.targetPath,
    relocatedAt: now().toISOString(),
  };
}

/**
 * True when a move is in progress — callers should pause work and await
 * the relocation before submitting new turns, tool calls, or persistence.
 */
export function isRelocating(state: WorkspaceMoveState): boolean {
  return state.phase === "relocating";
}

/**
 * True when a move has completed — the session now operates at the new
 * path; the original path is preserved in the snapshot for audit.
 */
export function isRelocated(state: WorkspaceMoveState): boolean {
  return state.phase === "relocated";
}
