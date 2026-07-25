/**
 * MidTaskWorkspaceMove — pure state machine for workspace relocation during a
 * running session. Marks a session as relocating, preserves worktreePath in a
 * snapshot, and transitions through idle → relocating → completed.
 *
 * No actual worktree, branch, session, or filesystem operations — this is the
 * state layer only. The executor/coordinator layers own the physical move.
 */

/** The relocation lifecycle. */
export type MoveStatus = "idle" | "relocating" | "completed";

/** Immutable snapshot captured when a move begins. */
export interface MoveSnapshot {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly startedAt: string; // ISO-8601
}

/** Full relocation state, valid in any lifecycle phase. */
export interface MidTaskWorkspaceMoveState {
  readonly status: MoveStatus;
  /** The snapshot captured at beginMove; undefined only when idle. */
  readonly snapshot: MoveSnapshot | null;
}

/** Parameters to initiate a mid-task workspace relocation. */
export interface BeginMoveParams {
  /** The current (source) workspace/working directory path. */
  readonly sourcePath: string;
  /** The target workspace path to relocate into. */
  readonly targetPath: string;
  /** ISO-8601 timestamp (caller-provided for deterministic testability). */
  readonly now: string;
}

// -- initial state -----------------------------------------------------------

/** The idle state — no relocation active or completed yet. */
export const IDLE_STATE: MidTaskWorkspaceMoveState = Object.freeze({
  status: "idle",
  snapshot: null
});

// -- guards ------------------------------------------------------------------

/** Returns true when a move has not yet been initiated. */
export function canBeginMove(state: MidTaskWorkspaceMoveState): boolean {
  return state.status === "idle";
}

/** Returns true when a move is actively in progress (between begin and complete). */
export function isRelocating(state: MidTaskWorkspaceMoveState): boolean {
  return state.status === "relocating";
}

/** Returns true when a move has been successfully completed. */
export function isMoveCompleted(state: MidTaskWorkspaceMoveState): boolean {
  return state.status === "completed";
}

// -- transitions -------------------------------------------------------------

/**
 * Begin a workspace relocation. Transitions idle → relocating and captures a
 * snapshot of the source workspace.
 *
 * Returns the new state on success, or an error string when the current status
 * forbids beginning a move.
 */
export function beginMove(
  state: MidTaskWorkspaceMoveState,
  params: BeginMoveParams
): MidTaskWorkspaceMoveState | string {
  if (state.status !== "idle") {
    return `Cannot begin workspace move: current status is "${state.status}"`;
  }
  if (!params.sourcePath || params.sourcePath.trim().length === 0) {
    return "Cannot begin workspace move: sourcePath is empty";
  }
  if (!params.targetPath || params.targetPath.trim().length === 0) {
    return "Cannot begin workspace move: targetPath is empty";
  }
  if (params.sourcePath === params.targetPath) {
    return "Cannot begin workspace move: sourcePath and targetPath are identical";
  }
  return Object.freeze({
    status: "relocating" as const,
    snapshot: Object.freeze({
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
      startedAt: params.now
    })
  });
}

/**
 * Complete a workspace relocation. Transitions relocating → completed.
 *
 * The snapshot is preserved so callers can inspect what was moved even after
 * the move has finished.
 *
 * Returns the new state on success, or an error string when the current status
 * forbids completion.
 */
export function completeMove(
  state: MidTaskWorkspaceMoveState
): MidTaskWorkspaceMoveState | string {
  if (state.status !== "relocating") {
    return `Cannot complete workspace move: current status is "${state.status}"`;
  }
  if (!state.snapshot) {
    return "Cannot complete workspace move: no snapshot (state invariant violated)";
  }
  return Object.freeze({
    status: "completed" as const,
    snapshot: state.snapshot // keep the snapshot for post-move inspection
  });
}

/**
 * Abort a relocation in progress, returning to idle. Only valid when status is
 * "relocating". The snapshot is discarded.
 *
 * Returns the new state on success, or an error string when the current status
 * forbids abort.
 */
export function abortMove(
  state: MidTaskWorkspaceMoveState
): MidTaskWorkspaceMoveState | string {
  if (state.status !== "relocating") {
    return `Cannot abort workspace move: current status is "${state.status}"`;
  }
  return IDLE_STATE;
}
