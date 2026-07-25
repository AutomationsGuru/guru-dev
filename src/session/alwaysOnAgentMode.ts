import { z } from "zod";

import { HARD_EDGE_VERBS, type MandateVerb } from "../mandates/schema.js";

/**
 * Always-on agent mode (IDEA-F192-ALWAYS-ON-01, letta-code always-on residual).
 *
 * A config flag that lets the harness schedule proactive wakes (it composes the
 * F189 heartbeat and F162 queue). It is **off by default** — a bare boot never
 * wakes on its own. Enabling it changes ONLY the wake schedule; it never
 * weakens the constitution. Hard limits are enforced elsewhere in code and this
 * module depends on — never duplicates — that machinery:
 *
 * - Deny rules and the hard edges (`destructive` / `spend` / `secret-edge` /
 *   `auth-edge`) resolve in {@link ../mandates/evaluate.ts} BEFORE YOLO, so
 *   always-on can never lift them.
 * - The per-call approval choke ({@link ../mandates/approval.ts}) default-DENYs
 *   a hard edge and never persists an "always" grant for one — so the spend cap
 *   is not auto-bypassed.
 *
 * `assertAlwaysOnHardLimitsIntact` is the plan's "assert hard limits still
 * required" step, encoded as a fail-closed runtime check: if the shared
 * hard-edge set is ever weakened, arming always-on throws instead of silently
 * running with a lifted cap.
 */

export const AlwaysOnAgentModeSchema = z
  .object({
    /** Master switch. Default OFF; also opt-in via env `GURU_ALWAYS_ON=1|true`. */
    enabled: z.boolean().default(false),
    /**
     * Minutes between scheduled wakes (F189 heartbeat period). A non-positive
     * value means "no schedule" so {@link isAlwaysOnActive} reports inactive —
     * an off schedule is a state, not a config error. Capped at one day.
     */
    wakeIntervalMinutes: z.number().int().max(24 * 60).default(15)
  })
  .strict();

export type AlwaysOnAgentMode = z.infer<typeof AlwaysOnAgentModeSchema>;

/** Env names only (presence-over-value) — never a secret, only an opt-in flag. */
const ALWAYS_ON_ENV = "GURU_ALWAYS_ON";

/**
 * Resolve the always-on mode from explicit input, falling back to the
 * `GURU_ALWAYS_ON` env opt-in, then to the off default. Explicit operator
 * config always beats the environment.
 */
export function createAlwaysOnAgentMode(input: Partial<AlwaysOnAgentMode> = {}): AlwaysOnAgentMode {
  const envEnabled = /^(1|true)$/i.test(process.env[ALWAYS_ON_ENV] ?? "");
  return AlwaysOnAgentModeSchema.parse({ enabled: envEnabled, ...input });
}

/**
 * True only when the mode is enabled AND carries a real (positive) wake
 * schedule. A zero/negative interval disables the schedule even if `enabled`.
 */
export function isAlwaysOnActive(mode: AlwaysOnAgentMode): boolean {
  return mode.enabled && mode.wakeIntervalMinutes > 0;
}

/** The hard-edge verbs always-on must never be able to lift (Constitution §3). */
const REQUIRED_HARD_EDGES: readonly MandateVerb[] = ["destructive", "spend", "secret-edge", "auth-edge"];

/**
 * Assert the hard limits still bind while always-on is armed. Fail-closed:
 * throws unless every hard edge is present in the live mandate constitution set
 * (`hardEdges` defaults to the real `HARD_EDGE_VERBS`; tests inject a weakened
 * set to prove the guard fires). A no-op when the mode is inactive.
 *
 * This adds no new enforcement — it detects drift in the *existing* enforcement
 * so a weakened constitution can never run under the guise of "always-on".
 */
export function assertAlwaysOnHardLimitsIntact(
  mode: AlwaysOnAgentMode,
  hardEdges: ReadonlySet<MandateVerb> = HARD_EDGE_VERBS
): void {
  if (!isAlwaysOnActive(mode)) {
    return;
  }
  const missing = REQUIRED_HARD_EDGES.filter((verb) => !hardEdges.has(verb));
  if (missing.length > 0) {
    throw new Error(
      `always-on agent mode refuses to arm: hard limits weakened (missing ${missing.join(", ")}). ` +
        "Always-on never lifts hard edges or the spend cap."
    );
  }
}
