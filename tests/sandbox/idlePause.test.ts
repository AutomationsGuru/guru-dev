import { describe, expect, it } from "vitest";
import {
  type IdlePauseBox,
  evaluateIdlePause,
  applyIdlePause,
  pauseBox,
  unpauseBox,
  isPauseable,
} from '../../src/sandbox/idlePause.js';

/**
 * R-AB-PAUSE — Sandbox idle pause.
 * After idleMs without activity a running box transitions to `paused`;
 * unpause restores `running`. Pure functions driven by an injected clock so
 * no real timers (and no Docker) are required in tests.
 */

const baseRunning = (lastActivity: number): IdlePauseBox => ({
  id: "box-1",
  status: "running",
  lastActivity,
  pausedAt: undefined,
});

describe("sandbox idle pause — evaluateIdlePause (R-AB-PAUSE)", () => {
  it("does not pause before the idle threshold elapses", () => {
    const decision = evaluateIdlePause({
      now: 10_000,
      lastActivity: 4_000,
      idleMs: 10_000,
      status: "running",
    });
    expect(decision.pause).toBe(false);
    expect(decision.pausedAt).toBeUndefined();
  });

  it("pauses exactly when idleMs has elapsed since lastActivity (>=)", () => {
    const at = evaluateIdlePause({
      now: 14_000,
      lastActivity: 4_000,
      idleMs: 10_000,
      status: "running",
    });
    expect(at.pause).toBe(true);
    expect(at.pausedAt).toBe(14_000);

    // Boundary: now - lastActivity == idleMs is still a pause (>=).
    const boundary = evaluateIdlePause({
      now: 14_000,
      lastActivity: 4_000,
      idleMs: 10_000,
      status: "running",
    });
    expect(boundary.pause).toBe(true);
  });

  it("never re-pauses / never returns a pause decision for a non-running box", () => {
    for (const status of ["created", "paused", "stopped", "destroyed"] as const) {
      const decision = evaluateIdlePause({
        now: 1_000_000,
        lastActivity: 0,
        idleMs: 1,
        status,
      });
      expect(decision.pause).toBe(false);
      expect(decision.pausedAt).toBeUndefined();
    }
  });

  it("rejects a non-positive idleMs (a pause budget must be a real, positive duration)", () => {
    expect(() =>
      evaluateIdlePause({ now: 5, lastActivity: 0, idleMs: 0, status: "running" }),
    ).toThrow(/idleMs/);
    expect(() =>
      evaluateIdlePause({ now: 5, lastActivity: 0, idleMs: -1, status: "running" }),
    ).toThrow(/idleMs/);
  });

  it("treats a clock that runs backwards (now < lastActivity) as not-yet-idle, never paused", () => {
    const decision = evaluateIdlePause({
      now: 1_000,
      lastActivity: 5_000,
      idleMs: 1_000,
      status: "running",
    });
    expect(decision.pause).toBe(false);
  });
});

describe("sandbox idle pause — applyIdlePause reducer", () => {
  it("transitions a running box to paused and stamps pausedAt, immutably", () => {
    const box = baseRunning(4_000);
    const decision = evaluateIdlePause({
      now: 14_001,
      lastActivity: box.lastActivity,
      idleMs: 10_000,
      status: box.status,
    });
    const next = applyIdlePause(box, decision, 14_001);
    expect(next.status).toBe("paused");
    expect(next.pausedAt).toBe(14_001);
    expect(next.lastActivity).toBe(4_000);
    // immutability: original untouched
    expect(box.status).toBe("running");
    expect(box.pausedAt).toBeUndefined();
  });

  it("is a no-op (returns an equal-shaped box) when the decision is pause=false", () => {
    const box = baseRunning(4_000);
    const decision = evaluateIdlePause({
      now: 5_000,
      lastActivity: box.lastActivity,
      idleMs: 10_000,
      status: box.status,
    });
    const next = applyIdlePause(box, decision, 5_000);
    expect(next.status).toBe("running");
    expect(next.pausedAt).toBeUndefined();
    expect(next.lastActivity).toBe(4_000);
  });
});

describe("sandbox idle pause — pauseBox (one-shot helper)", () => {
  it("pauses a running box that has been idle long enough", () => {
    const box = baseRunning(0);
    const next = pauseBox(box, { now: 60_000, idleMs: 30_000 });
    expect(next.status).toBe("paused");
    expect(next.pausedAt).toBe(60_000);
  });

  it("leaves a still-active running box running", () => {
    const box = baseRunning(50_000);
    const next = pauseBox(box, { now: 60_000, idleMs: 30_000 });
    expect(next.status).toBe("running");
    expect(next.pausedAt).toBeUndefined();
  });
});

describe("sandbox idle pause — unpauseBox restores running", () => {
  it("restores a paused box to running and bumps lastActivity to now", () => {
    const paused: IdlePauseBox = {
      id: "box-1",
      status: "paused",
      lastActivity: 4_000,
      pausedAt: 14_000,
    };
    const { box } = unpauseBox(paused, { now: 90_000 });
    expect(box.status).toBe("running");
    expect(box.lastActivity).toBe(90_000);
    expect(box.pausedAt).toBeUndefined();
  });

  it("records the prior paused moment on the returned box for audit before clearing it", () => {
    // unpause clears the active pause but the prior pausedAt is preserved via the
    // returned `previouslyPausedAt` field so the operator/audit can see how long
    // the box sat paused.
    const paused: IdlePauseBox = {
      id: "box-9",
      status: "paused",
      lastActivity: 4_000,
      pausedAt: 14_000,
    };
    const result = unpauseBox(paused, { now: 90_000 });
    expect(result.box.status).toBe("running");
    expect(result.box.pausedAt).toBeUndefined();
    expect(result.previouslyPausedAt).toBe(14_000);
  });

  it("rejects unpausing a box that is not paused (no silent status invention)", () => {
    const running = baseRunning(0);
    expect(() => unpauseBox(running, { now: 100 })).toThrow(/paused/);
    const stopped: IdlePauseBox = { id: "x", status: "stopped", lastActivity: 0, pausedAt: undefined };
    expect(() => unpauseBox(stopped, { now: 100 })).toThrow(/paused/);
  });
});

describe("sandbox idle pause — isPauseable guard", () => {
  it("only a running box is pauseable", () => {
    expect(isPauseable("running")).toBe(true);
    for (const s of ["created", "paused", "stopped", "destroyed"] as const) {
      expect(isPauseable(s)).toBe(false);
    }
  });
});

describe("sandbox idle pause — fake-clock simulation (R-AB-PAUSE end-to-end)", () => {
  it("full lifecycle: run → idle past threshold → paused → activity → running again", () => {
    type Clock = { now: number };
    const clock: Clock = { now: 1_000 };
    let box: IdlePauseBox = {
      id: "sim",
      status: "running",
      lastActivity: clock.now,
      pausedAt: undefined,
    };
    const idleMs = 5_000;

    // Advance the clock without activity — just under threshold: still running.
    clock.now = 5_999;
    box = applyIdlePause(
      box,
      evaluateIdlePause({
        now: clock.now,
        lastActivity: box.lastActivity,
        idleMs,
        status: box.status,
      }),
      clock.now,
    );
    expect(box.status).toBe("running");

    // Cross the threshold with no activity: paused.
    clock.now = 6_001;
    box = applyIdlePause(
      box,
      evaluateIdlePause({
        now: clock.now,
        lastActivity: box.lastActivity,
        idleMs,
        status: box.status,
      }),
      clock.now,
    );
    expect(box.status).toBe("paused");
    expect(box.pausedAt).toBe(6_001);

    // Operator activity resumes the box; it is running again and the clock resets.
    clock.now = 9_000;
    const resumed = unpauseBox(box, { now: clock.now });
    box = resumed.box;
    expect(box.status).toBe("running");
    expect(box.lastActivity).toBe(9_000);

    // Immediately after resume it is not re-paused (idle window restarted).
    clock.now = 9_100;
    box = applyIdlePause(
      box,
      evaluateIdlePause({
        now: clock.now,
        lastActivity: box.lastActivity,
        idleMs,
        status: box.status,
      }),
      clock.now,
    );
    expect(box.status).toBe("running");
  });
});
