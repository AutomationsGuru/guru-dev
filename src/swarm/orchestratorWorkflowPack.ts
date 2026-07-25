import { z, type ZodIssue } from "zod";

import { SwarmWorkerModeSchema, type SwarmWorkerMode } from "./schema.js";

/**
 * Orchestrator workflow pack (IDEA-F405-ORCH-01 / R-WSH-ORCH) — a named,
 * ORDERED list of agent roles plus the id of the stop gate the operator uses
 * to decide whether to proceed past the pack. This composes over the existing
 * swarm residual (the bounded scheduler in manager.ts); it does NOT introduce a
 * new scheduler, framework, or second fan-out path. A pack is a declarative
 * recipe the operator points the swarm at — the harness stays the runtime.
 *
 * Vision posture:
 *  - No borrowed ceiling: pure zod + a parse function; no orchestration SDK.
 *  - Operator-override discipline enforced in code, not prose: a pack MUST
 *    declare a stop gate id, so the pack never silently runs past the operator.
 *  - Bounded: role count and prompt length are hard-capped so a malformed pack
 *    cannot unleash unbounded fan-out (the swarm's own caps still bind at run).
 */

/** A single ordered role step in the pack. Order is the run order. */
export const OrchestratorRoleStepSchema = z
  .object({
    /** Stable role name (e.g. "scout", "implementer", "reviewer"). */
    role: z.string().trim().min(1).max(60),
    /**
     * The worker mode this role runs under. Mirrors the swarm's existing
     * read-only / all split so approval policy stays the swarm's, not the
     * pack's. Defaults to the safe "read-only" scout.
     */
    mode: SwarmWorkerModeSchema.default("read-only"),
    /**
     * The prompt this role executes. Optional only when an external caller
     * supplies the prompt at run time; when present it is hard-capped so a
     * pack cannot carry an unbounded payload.
     */
    prompt: z.string().trim().min(1).max(4_000).optional(),
    /** Optional human label (mirrors the swarm task label). */
    label: z.string().trim().min(1).max(60).optional()
  })
  .strict();

export type OrchestratorRoleStep = z.infer<typeof OrchestratorRoleStepSchema>;

/**
 * Structured error when a pack is malformed. A bad pack is a stop condition,
 * never silently coerced into an empty run.
 */
export class OrchestratorPackValidationError extends Error {
  readonly code = "orchestrator_pack_invalid";
  readonly issues: readonly z.ZodIssue[];
  constructor(message: string, issues: readonly z.ZodIssue[]) {
    super(message);
    this.name = "OrchestratorPackValidationError";
    this.issues = issues;
  }
}

/** Hard cap on the number of roles a pack may declare. */
export const ORCHESTRATOR_PACK_MAX_ROLES = 16;

export const OrchestratorWorkflowPackSchema = z
  .object({
    /** Stable pack id (the name the operator points the swarm at). */
    id: z.string().trim().min(1).max(80),
    /** Human-readable pack name. */
    name: z.string().trim().min(1).max(120),
    /** Ordered role steps — at least one, hard-capped. */
    roles: z.array(OrchestratorRoleStepSchema).min(1).max(ORCHESTRATOR_PACK_MAX_ROLES),
    /**
     * The id of the stop gate the operator uses to decide whether to proceed
     * past this pack. Required and non-blank: a pack never silently runs past
     * the operator. The gate itself is evaluated elsewhere — the pack only
     * NAMES it, so the pack layer cannot bypass review.
     */
    stopGateId: z.string().trim().min(1).max(80),
    /** Optional one-line description. */
    description: z.string().trim().min(1).max(400).optional()
  })
  .strict();

export type OrchestratorWorkflowPack = z.infer<typeof OrchestratorWorkflowPackSchema>;

/**
 * Parse + validate a raw pack. Throws OrchestratorPackValidationError on any
 * malformed input (empty roles, missing stop gate, bad role shape, unknown
 * keys) so callers get a single structured failure instead of a raw zod throw.
 *
 * Use this as the only entry point: never trust a raw pack object at run time.
 */
export function parsePack(raw: unknown): OrchestratorWorkflowPack {
  const result = OrchestratorWorkflowPackSchema.safeParse(raw);
  if (!result.success) {
    throw new OrchestratorPackValidationError(
      `Orchestrator workflow pack is invalid: ${result.error.issues.map((i: ZodIssue) => i.message).join("; ")}`,
      result.error.issues
    );
  }
  return result.data;
}

/** Convenience predicate — true iff raw is a valid pack. */
export function isValidPack(raw: unknown): raw is OrchestratorWorkflowPack {
  return OrchestratorWorkflowPackSchema.safeParse(raw).success;
}

/**
 * Expand a validated pack into the ordered (role, mode, prompt) triples the
 * swarm manager consumes. This is the only seam between a pack and the swarm:
 * it produces plain values; spawn() still goes through manager.spawn and the
 * swarm's caps (concurrency, depth, budget, task cap) still bind at run time.
 * A role with no prompt yields undefined, signalling the caller supplies it.
 */
export interface OrchestratorPlannedStep {
  readonly role: string;
  readonly mode: SwarmWorkerMode;
  readonly prompt: string | undefined;
  readonly label: string | undefined;
  readonly order: number;
}

export function planPackSteps(pack: OrchestratorWorkflowPack): readonly OrchestratorPlannedStep[] {
  return pack.roles.map((step: OrchestratorRoleStep, order: number) => ({
    role: step.role,
    mode: step.mode,
    prompt: step.prompt,
    label: step.label,
    order
  }));
}
