/**
 * Autonomy mode boot selector (F376, IDEA-F376-MODEBOOT-01).
 *
 * Maps a boot-time mode name (normal | plan | yolo | auto-accept) to tool-approval
 * posture defaults. Unknown modes fail closed (throw). Hard limits (destructive,
 * spend, secret-edge, auth-edge — HARD_EDGE_VERBS in schema.ts) are NEVER lifted
 * by any autonomy mode, including yolo; the approval pipeline enforces that
 * independently, and hardLimitDeny:true reflects it in the mode defaults.
 *
 * Constitution §3: YOLO lifts ordinary permission gates but NOT hard limits.
 * This module encodes that invariant structurally — no mode can set
 * hardLimitDeny:false.
 */

/** Canonical autonomy mode names. */
export const AUTONOMY_MODES = ["normal", "plan", "yolo", "auto-accept"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** Approval posture derived from a boot autonomy mode. */
export interface ModeApprovalDefaults {
  /** Default for non-hard-edge escalations: auto-approve, prompt the operator, or deny. */
  readonly escalateDefault: "approve" | "prompt" | "deny";
  /** Whether hard-edge verbs (destructive / spend / secret-edge / auth-edge) always
   *  escalate — structurally true for every mode; YOLO never lifts hard limits. */
  readonly hardLimitDeny: true;
  /** Whether a read-only tool can self-escalate to a write without prompting
   *  (plan mode denies; yolo/auto-accept allow it). */
  readonly allowAutoEscalate: boolean;
}

const DEFAULTS: Record<AutonomyMode, ModeApprovalDefaults> = {
  normal: { escalateDefault: "prompt", hardLimitDeny: true, allowAutoEscalate: false },
  plan: { escalateDefault: "deny", hardLimitDeny: true, allowAutoEscalate: false },
  yolo: { escalateDefault: "approve", hardLimitDeny: true, allowAutoEscalate: true },
  "auto-accept": { escalateDefault: "approve", hardLimitDeny: true, allowAutoEscalate: true }
};

/** Result of a successful mode resolution. */
export interface ResolvedMode {
  readonly mode: AutonomyMode;
  readonly defaults: ModeApprovalDefaults;
}

/** Guards: is `s` a known autonomy mode name? */
export function isAutonomyMode(s: string): s is AutonomyMode {
  return (AUTONOMY_MODES as readonly string[]).includes(s.trim().toLowerCase());
}

/**
 * Resolve a mode name into its {@link AutonomyMode} and approval defaults.
 *
 * Input is trimmed and lowercased so "YOLO", "  plan  ", and "Auto-Accept"
 * all resolve correctly.
 *
 * Unknown mode names throw — fail closed, never silently default.
 * The error message enumerates the valid modes so the caller can surface it.
 */
export function resolveMode(name: string): ResolvedMode {
  const lower = name.trim().toLowerCase();
  const mode = (AUTONOMY_MODES as readonly string[]).find((m) => m === lower) as AutonomyMode | undefined;
  if (!mode) {
    throw new Error(
      `Unknown autonomy mode: ${JSON.stringify(name)}. Expected one of: ${AUTONOMY_MODES.join(", ")}.`
    );
  }
  return { mode, defaults: DEFAULTS[mode] };
}
