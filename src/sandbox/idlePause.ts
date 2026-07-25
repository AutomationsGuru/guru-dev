/**
 * Sandbox idle pause — R-AB-PAUSE (IDEA-F343-PAUSE-01).
 *
 * Pure, clock-injected idle-pause logic for a sandbox box record. After `idleMs`
 * have elapsed since the box's last activity a *running* box transitions to
 * `paused`; unpausing restores `running` and restarts the idle window. No Docker,
 * no real timers, no I/O — the caller drives time by passing `now`.
 *
 * Status model composes with the box lifecycle registry (IDEA-F342-BOX-01):
 * `created | running | paused | stopped | destroyed`. Only a `running` box is
 * ever paused; `paused` is a recoverable hold, not a terminal state.
 */

/**
 * Sandbox box status. Extends the box-lifecycle status set (`created | running |
 * stopped | destroyed`) with the recoverable `paused` hold introduced here.
 */
export type SandboxBoxStatus = "created" | "running" | "paused" | "stopped" | "destroyed";

/**
 * A sandbox box record as seen by the idle-pause logic. The lifecycle registry
 * owns the canonical record; this is the slice idle-pause reads and produces.
 */
export interface IdlePauseBox {
  /** Stable box identifier (owned by the lifecycle registry). */
  readonly id: string;
  /** Current box status. Only `running` is pauseable. */
  status: SandboxBoxStatus;
  /** ms-epoch of the last activity that should reset the idle window. */
  lastActivity: number;
  /** ms-epoch the box entered `paused`, or `undefined` when not paused. */
  pausedAt: number | undefined;
}

/** Input to a single idle-pause evaluation tick. */
export interface IdlePauseTickInput {
  /** ms-epoch "now" (injected clock). */
  now: number;
  /** ms-epoch of the box's last activity. */
  lastActivity: number;
  /** Idle threshold in ms; must be a positive, finite number. */
  idleMs: number;
  /** Current box status (only `running` is pauseable). */
  status: SandboxBoxStatus;
}

/** Output of an idle-pause evaluation tick. */
export interface IdlePauseDecision {
  /** Whether the box should transition to `paused` on this tick. */
  readonly pause: boolean;
  /** ms-epoch at which the pause would take effect (`now`), or `undefined`. */
  readonly pausedAt: number | undefined;
}

/**
 * Decide whether a box should be paused on this tick. Pure — no side effects.
 *
 * Pauses only when ALL hold:
 *   - `idleMs` is a positive, finite duration (a real pause budget);
 *   - the box is currently `running` (terminal/non-running states are never
 *     paused — `paused` is a recoverable hold, not a status to invent);
 *   - `now >= lastActivity + idleMs` (the idle threshold has elapsed).
 *
 * A clock that has run backwards (`now < lastActivity`) never pauses — it is
 * treated as not-yet-idle rather than infinitely idle.
 */
export function evaluateIdlePause(input: IdlePauseTickInput): IdlePauseDecision {
  const { now, lastActivity, idleMs, status } = input;
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    throw new Error(
      `idlePause: idleMs must be a positive, finite number of milliseconds (got ${idleMs})`,
    );
  }
  if (status !== "running") {
    return { pause: false, pausedAt: undefined };
  }
  if (!Number.isFinite(now) || !Number.isFinite(lastActivity) || now < lastActivity) {
    return { pause: false, pausedAt: undefined };
  }
  const idleFor = now - lastActivity;
  if (idleFor >= idleMs) {
    return { pause: true, pausedAt: now };
  }
  return { pause: false, pausedAt: undefined };
}

/** Only a `running` box is a legal pause candidate. */
export function isPauseable(status: SandboxBoxStatus): boolean {
  return status === "running";
}

/**
 * Immutably apply an idle-pause decision to a box.
 *
 * - `pause === true`: the box must currently be `running`; it transitions to
 *   `paused` with `pausedAt = at` (its `lastActivity` is preserved so the idle
 *   window can be reasoned about after resume).
 * - `pause === false`: a structural no-op — the box is returned with the same
 *   shape (a fresh object; never mutates the input).
 *
 * Throws on an illegal transition (e.g. a `pause=true` decision against a box
 * that is no longer `running`) rather than silently inventing status.
 */
export function applyIdlePause(
  box: IdlePauseBox,
  decision: IdlePauseDecision,
  at: number,
): IdlePauseBox {
  if (!decision.pause) {
    return { ...box };
  }
  if (box.status !== "running") {
    throw new Error(
      `idlePause: cannot pause box "${box.id}" in status "${box.status}" (only running is pauseable)`,
    );
  }
  return {
    ...box,
    status: "paused",
    pausedAt: at,
  };
}

/** Input to the one-shot pause helper. */
export interface PauseBoxInput {
  /** ms-epoch "now" (injected clock). */
  now: number;
  /** Idle threshold in ms; must be a positive, finite number. */
  idleMs: number;
}

/**
 * Convenience: evaluate + apply in one call. Returns a new box that is `paused`
 * if the running box has been idle past `idleMs`, otherwise the same-shape box
 * unchanged. Never mutates the input.
 */
export function pauseBox(box: IdlePauseBox, input: PauseBoxInput): IdlePauseBox {
  const decision = evaluateIdlePause({
    now: input.now,
    lastActivity: box.lastActivity,
    idleMs: input.idleMs,
    status: box.status,
  });
  return applyIdlePause(box, decision, input.now);
}

/** Result of unpausing: the resumed box plus the prior pause moment for audit. */
export interface UnpauseResult {
  /** The resumed box (`running`, idle window restarted at `now`). */
  readonly box: IdlePauseBox;
  /** ms-epoch the box was previously paused at, or `undefined` if it was not paused. */
  readonly previouslyPausedAt: number | undefined;
}

/** Input to {@link unpauseBox}. */
export interface UnpauseInput {
  /** ms-epoch "now" (injected clock); becomes the new `lastActivity`. */
  now: number;
}

/**
 * Resume a paused box: status → `running`, `lastActivity` → `now` (the idle
 * window restarts), and `pausedAt` cleared. The prior `pausedAt` is surfaced on
 * the result as `previouslyPausedAt` so the operator / audit can see how long
 * the box sat paused.
 *
 * Throws if the box is not currently `paused` — unpausing a running/stopped/
 * destroyed box would silently invent status. Never mutates the input.
 */
export function unpauseBox(box: IdlePauseBox, input: UnpauseInput): UnpauseResult {
  if (box.status !== "paused") {
    throw new Error(
      `idlePause: cannot unpause box "${box.id}" in status "${box.status}" (only paused can be unpaused)`,
    );
  }
  const previouslyPausedAt = box.pausedAt;
  return {
    box: {
      ...box,
      status: "running",
      lastActivity: input.now,
      pausedAt: undefined,
    },
    previouslyPausedAt,
  };
}
