/**
 * Spec → implement autonomy handoff (idea F129 / R-FD-SPEC, 2026-07-19).
 *
 * Plan-only (spec) freezes mutation until the operator explicitly approves the
 * plan and chooses the autonomy level for the implement phase. Spec posture is
 * orthogonal to autonomy (factory-droid K5/K6): plan ≠ permissions; approval is
 * the controlled handoff. Composes conceptually with F64 plan|act and F108
 * autonomy risk levels without importing those modules (they are not on this
 * base tip) — this module owns only the sticky handoff state + gate.
 *
 * Hard limits always bind: `hardLimitsEnforced` is structurally `true` at every
 * level including `high`. YOLO / high autonomy never lifts them (Constitution
 * §3 / VISION hard limits).
 *
 * Session state is a module-level singleton (sticky per-process) with
 * `resetSpecHandoff` for test isolation, defaulting to plan-only / medium so a
 * session that never approves cannot mutate.
 */

/** Phase of the spec→implement lifecycle. */
export type SpecPhase = "plan-only" | "implement";

/**
 * Autonomy choice offered at approval. `keep` means "preserve the current
 * session autonomy" rather than a stored level.
 */
export type AutonomyLevelChoice = "keep" | "low" | "medium" | "high";

/** Resolved autonomy level after approval (`keep` is never stored). */
export type AutonomyLevel = "low" | "medium" | "high";

/** Sticky handoff state for the current session. */
export interface SpecHandoffState {
  readonly phase: SpecPhase;
  /** Current resolved autonomy (default `medium` until changed). */
  readonly autonomy: AutonomyLevel;
  /** True only after a successful {@link approveSpec}. */
  readonly approved: boolean;
  /** Always true — hard limits are never liftable by autonomy level. */
  readonly hardLimitsEnforced: true;
}

/** Input to {@link approveSpec}. */
export interface ApproveSpecInput {
  readonly level: AutonomyLevelChoice;
}

/** Result of an approval attempt. Fail-closed: invalid input yields `ok: false`. */
export type ApproveSpecResult =
  | { readonly ok: true; readonly state: SpecHandoffState; readonly previous: SpecHandoffState }
  | { readonly ok: false; readonly reason: string; readonly state: SpecHandoffState };

/** Result of the implement gate. */
export type ImplementGateResult =
  | { readonly allowed: true; readonly state: SpecHandoffState }
  | { readonly allowed: false; readonly reason: string; readonly state: SpecHandoffState };

const VALID_LEVELS: readonly AutonomyLevel[] = ["low", "medium", "high"];
const VALID_CHOICES: readonly AutonomyLevelChoice[] = ["keep", "low", "medium", "high"];

const DEFAULT_STATE: SpecHandoffState = {
  phase: "plan-only",
  autonomy: "medium",
  approved: false,
  hardLimitsEnforced: true
};

let current: SpecHandoffState = { ...DEFAULT_STATE };

function snapshot(): SpecHandoffState {
  return {
    phase: current.phase,
    autonomy: current.autonomy,
    approved: current.approved,
    hardLimitsEnforced: true
  };
}

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === "string" && (VALID_LEVELS as readonly string[]).includes(value);
}

function isAutonomyLevelChoice(value: unknown): value is AutonomyLevelChoice {
  return typeof value === "string" && (VALID_CHOICES as readonly string[]).includes(value);
}

/** Read the sticky handoff state (defaults to plan-only / medium / not approved). */
export function getSpecHandoffState(): SpecHandoffState {
  return snapshot();
}

/**
 * Reset sticky state for tests or a fresh plan cycle.
 * Defaults to plan-only / medium / not approved / hardLimitsEnforced.
 * Partial overrides may set phase/autonomy/approved; hardLimitsEnforced is always true.
 */
export function resetSpecHandoff(partial?: Partial<Pick<SpecHandoffState, "phase" | "autonomy" | "approved">>): void {
  const autonomy = partial?.autonomy !== undefined && isAutonomyLevel(partial.autonomy) ? partial.autonomy : DEFAULT_STATE.autonomy;
  const phase: SpecPhase = partial?.phase === "implement" || partial?.phase === "plan-only" ? partial.phase : DEFAULT_STATE.phase;
  const approved = typeof partial?.approved === "boolean" ? partial.approved : DEFAULT_STATE.approved;
  current = { phase, autonomy, approved, hardLimitsEnforced: true };
}

/**
 * Enter (or re-enter) plan-only mode, clearing approval.
 * Optional `autonomy` sets the level that `keep` will preserve on next approval.
 */
export function enterPlanOnly(autonomy?: AutonomyLevel): void {
  current = {
    phase: "plan-only",
    autonomy: autonomy !== undefined && isAutonomyLevel(autonomy) ? autonomy : current.autonomy,
    approved: false,
    hardLimitsEnforced: true
  };
}

/**
 * Approve the current plan and transition to implement at the chosen autonomy.
 *
 * Accepts either `{ level }` or a bare choice string. `keep` preserves the
 * current resolved autonomy; `low` / `medium` / `high` set it explicitly.
 * Invalid choices fail closed with `ok: false` and leave state unchanged.
 * Re-approval while already in implement is allowed (operator may raise/lower
 * autonomy mid-flight without returning to plan-only).
 */
export function approveSpec(input: ApproveSpecInput | AutonomyLevelChoice): ApproveSpecResult {
  const previous = snapshot();
  const raw = typeof input === "string" ? input : input && typeof input === "object" ? (input as ApproveSpecInput).level : undefined;

  if (!isAutonomyLevelChoice(raw)) {
    return {
      ok: false,
      reason: `invalid autonomy choice: ${JSON.stringify(raw)}. Expected one of: ${VALID_CHOICES.join(", ")}.`,
      state: previous
    };
  }

  const nextAutonomy: AutonomyLevel = raw === "keep" ? current.autonomy : raw;
  current = {
    phase: "implement",
    autonomy: nextAutonomy,
    approved: true,
    hardLimitsEnforced: true
  };
  return { ok: true, state: snapshot(), previous };
}

/**
 * Gate for implement-phase work. Rejects when still plan-only or not approved.
 * Hard limits remain enforced even when allowed.
 */
export function assertImplementAllowed(): ImplementGateResult {
  const state = snapshot();
  if (state.phase === "plan-only" || !state.approved) {
    return {
      allowed: false,
      reason: "still plan-only without approval — call approveSpec({keep|low|medium|high}) before implementing",
      state
    };
  }
  return { allowed: true, state };
}

/** True only when phase is implement and the plan has been approved. */
export function mayMutate(): boolean {
  return current.phase === "implement" && current.approved;
}

/** Hard limits bind in every phase and every autonomy level. Always true. */
export function hardLimitsAlwaysBind(): true {
  return true;
}
