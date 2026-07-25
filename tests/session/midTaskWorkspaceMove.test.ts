import { describe, expect, it } from "vitest";

import {
  abortMove,
  beginMove,
  canBeginMove,
  completeMove,
  IDLE_STATE,
  isMoveCompleted,
  isRelocating,
  type BeginMoveParams,
  type MidTaskWorkspaceMoveState,
  type MoveSnapshot
} from '../../src/session/midTaskWorkspaceMove.js';

// -- helpers -----------------------------------------------------------------

const now = "2026-07-19T17:32:00.000Z";

function beginParams(
  over: Partial<BeginMoveParams> = {}
): BeginMoveParams {
  return {
    sourcePath: "/home/codex/worktrees/source-wt",
    targetPath: "/home/codex/worktrees/target-wt",
    now,
    ...over
  };
}

// -- initial state / guards --------------------------------------------------

describe("midTaskWorkspaceMove — initial state and guards", () => {
  it("IDLE_STATE is idle with null snapshot", () => {
    expect(IDLE_STATE.status).toBe("idle");
    expect(IDLE_STATE.snapshot).toBeNull();
  });

  it("IDLE_STATE is frozen (immutable)", () => {
    expect(Object.isFrozen(IDLE_STATE)).toBe(true);
  });

  it("canBeginMove returns true when idle", () => {
    expect(canBeginMove(IDLE_STATE)).toBe(true);
  });

  it("isRelocating returns false when idle", () => {
    expect(isRelocating(IDLE_STATE)).toBe(false);
  });

  it("isMoveCompleted returns false when idle", () => {
    expect(isMoveCompleted(IDLE_STATE)).toBe(false);
  });
});

// -- beginMove ----------------------------------------------------------------

describe("midTaskWorkspaceMove — beginMove", () => {
  it("ACCEPTANCE: transitions idle → relocating and captures the snapshot", () => {
    const result = beginMove(IDLE_STATE, beginParams());
    expect(typeof result).toBe("object");
    if (typeof result === "string") throw new Error(`unexpected error: ${result}`);
    expect(result.status).toBe("relocating");
    expect(result.snapshot).not.toBeNull();

    const snap = result.snapshot as MoveSnapshot;
    expect(snap.sourcePath).toBe("/home/codex/worktrees/source-wt");
    expect(snap.targetPath).toBe("/home/codex/worktrees/target-wt");
    expect(snap.startedAt).toBe(now);
  });

  it("result state is frozen (immutable)", () => {
    const result = beginMove(IDLE_STATE, beginParams());
    if (typeof result === "string") throw new Error(`unexpected error: ${result}`);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it("snapshot preserves caller-provided values byte-identically", () => {
    const params = beginParams({
      sourcePath: "/a/src",
      targetPath: "/b/dst",
      now: "2025-01-01T00:00:00.000Z"
    });
    const result = beginMove(IDLE_STATE, params);
    if (typeof result === "string") throw new Error(`unexpected error: ${result}`);
    expect(result.snapshot).toEqual({
      sourcePath: "/a/src",
      targetPath: "/b/dst",
      startedAt: "2025-01-01T00:00:00.000Z"
    });
  });

  it("rejects empty sourcePath", () => {
    expect(beginMove(IDLE_STATE, beginParams({ sourcePath: "" }))).toBe(
      "Cannot begin workspace move: sourcePath is empty"
    );
    expect(beginMove(IDLE_STATE, beginParams({ sourcePath: "   " }))).toBe(
      "Cannot begin workspace move: sourcePath is empty"
    );
  });

  it("rejects empty targetPath", () => {
    expect(beginMove(IDLE_STATE, beginParams({ targetPath: "" }))).toBe(
      "Cannot begin workspace move: targetPath is empty"
    );
    expect(beginMove(IDLE_STATE, beginParams({ targetPath: "   " }))).toBe(
      "Cannot begin workspace move: targetPath is empty"
    );
  });

  it("rejects identical source and target paths", () => {
    const same = "/home/codex/same-path";
    expect(beginMove(IDLE_STATE, beginParams({ sourcePath: same, targetPath: same }))).toBe(
      "Cannot begin workspace move: sourcePath and targetPath are identical"
    );
  });

  it("rejects begin when status is already relocating", () => {
    const first = beginMove(IDLE_STATE, beginParams());
    if (typeof first === "string") throw new Error(`unexpected error: ${first}`);
    expect(beginMove(first, beginParams({ sourcePath: "/other/src" }))).toBe(
      'Cannot begin workspace move: current status is "relocating"'
    );
  });

  it("rejects begin when status is completed", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);
    const done = completeMove(relocating);
    if (typeof done === "string") throw new Error(`unexpected error: ${done}`);
    expect(beginMove(done, beginParams({ sourcePath: "/another/src" }))).toBe(
      'Cannot begin workspace move: current status is "completed"'
    );
  });
});

// -- completeMove -------------------------------------------------------------

describe("midTaskWorkspaceMove — completeMove", () => {
  it("ACCEPTANCE: transitions relocating → completed, preserves snapshot", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);

    const result = completeMove(relocating);
    if (typeof result === "string") throw new Error(`unexpected error: ${result}`);
    expect(result.status).toBe("completed");
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot?.sourcePath).toBe("/home/codex/worktrees/source-wt");
    expect(result.snapshot?.targetPath).toBe("/home/codex/worktrees/target-wt");
  });

  it("result state is frozen (immutable)", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);
    const result = completeMove(relocating);
    if (typeof result === "string") throw new Error(`unexpected error: ${result}`);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects complete when idle (no move in progress)", () => {
    expect(completeMove(IDLE_STATE)).toBe(
      'Cannot complete workspace move: current status is "idle"'
    );
  });

  it("rejects complete when already completed (idempotent guard)", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);
    const done = completeMove(relocating);
    if (typeof done === "string") throw new Error(`unexpected error: ${done}`);
    expect(completeMove(done)).toBe(
      'Cannot complete workspace move: current status is "completed"'
    );
  });
});

// -- abortMove ----------------------------------------------------------------

describe("midTaskWorkspaceMove — abortMove", () => {
  it("ACCEPTANCE: transitions relocating → idle, snapshot discarded", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);

    const result = abortMove(relocating);
    expect(result).toBe(IDLE_STATE);
    // Verify it IS IDLE_STATE (reference equality — same frozen object).
    expect(result).toBe(IDLE_STATE);
  });

  it("rejects abort when idle", () => {
    expect(abortMove(IDLE_STATE)).toBe(
      'Cannot abort workspace move: current status is "idle"'
    );
  });

  it("rejects abort when already completed", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);
    const done = completeMove(relocating);
    if (typeof done === "string") throw new Error(`unexpected error: ${done}`);
    expect(abortMove(done)).toBe(
      'Cannot abort workspace move: current status is "completed"'
    );
  });
});

// -- full lifecycle and guards after each transition --------------------------

describe("midTaskWorkspaceMove — full lifecycle", () => {
  it("idle → relocating → completed: guards reflect each phase", () => {
    // Phase 1: idle
    const idle: MidTaskWorkspaceMoveState = IDLE_STATE;
    expect(canBeginMove(idle)).toBe(true);
    expect(isRelocating(idle)).toBe(false);
    expect(isMoveCompleted(idle)).toBe(false);

    // Phase 2: relocating
    const relocating = beginMove(idle, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);
    expect(canBeginMove(relocating)).toBe(false);
    expect(isRelocating(relocating)).toBe(true);
    expect(isMoveCompleted(relocating)).toBe(false);

    // Phase 3: completed
    const done = completeMove(relocating);
    if (typeof done === "string") throw new Error(`unexpected error: ${done}`);
    expect(canBeginMove(done)).toBe(false);
    expect(isRelocating(done)).toBe(false);
    expect(isMoveCompleted(done)).toBe(true);
  });

  it("idle → relocating → abort → idle: round-trip to clean state", () => {
    const relocating = beginMove(IDLE_STATE, beginParams());
    if (typeof relocating === "string") throw new Error(`unexpected error: ${relocating}`);
    const backToIdle = abortMove(relocating);
    expect(backToIdle).toBe(IDLE_STATE);
    // Can begin a new move from the aborted state
    expect(canBeginMove(backToIdle as MidTaskWorkspaceMoveState)).toBe(true);
  });

  it("multiple independent move cycles from idle", () => {
    for (let i = 0; i < 3; i++) {
      const relocating = beginMove(IDLE_STATE, beginParams({
        sourcePath: `/src-${i}`,
        targetPath: `/dst-${i}`,
        now: `2026-07-19T${String(i).padStart(2, "0")}:00:00.000Z`
      }));
      if (typeof relocating === "string") throw new Error(`cycle ${i}: ${relocating}`);
      expect(relocating.snapshot?.sourcePath).toBe(`/src-${i}`);
      expect(relocating.snapshot?.targetPath).toBe(`/dst-${i}`);

      const done = completeMove(relocating);
      if (typeof done === "string") throw new Error(`cycle ${i}: ${done}`);
      expect(done.status).toBe("completed");
      expect(done.snapshot?.sourcePath).toBe(`/src-${i}`);

      // Cannot re-begin from completed; that's the caller's job to replace
      // state with IDLE_STATE or a fresh object if they want a new move.
    }
  });
});
