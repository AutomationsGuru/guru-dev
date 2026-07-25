import { z } from "zod";

/**
 * Ship vs scout task shape (IDEA-A2, 2026-07-18) — a first-class discriminator on
 * every spawned worker. A scout is read-oriented and MUST leave a durable report
 * artifact; a ship is mutation-capable under mandate and must record verification.
 * Dispatch alone is never "done" for either shape: completion is proven by an
 * artifact (scout) or verification notes / an explicit operator skip (ship).
 *
 * This module is the structural contract — the shapes, the completion requirements,
 * and the fail-closed evaluation. It is enforced by the swarm manager + spawn tool,
 * never by prompt text. The default stays `ship` for backward compatibility; the
 * spawn schema defaults explore/read-only workers to `scout`.
 */

export const TaskShapeSchema = z.enum(["ship", "scout"]);
export type TaskShape = z.infer<typeof TaskShapeSchema>;

/**
 * The durable evidence a FINISHED worker must leave behind to count as complete.
 * Exactly one variant per shape — a scout cannot satisfy completion with ship
 * verification, and a ship cannot satisfy it with a scout report.
 */
export const ShipCompletionSchema = z
  .object({
    shape: z.literal("ship"),
    /** What the ship verified and how (tests run, checks, outcome). */
    verificationNotes: z.string().trim().min(1).optional(),
    /**
     * Operator explicitly waived verification for this ship. Structural, never a
     * prompt default: when true, verificationNotes may be absent. When false/absent,
     * verificationNotes are required.
     */
    operatorSkip: z.boolean().optional()
  })
  .strict();

export const ScoutCompletionSchema = z
  .object({
    shape: z.literal("scout"),
    /**
     * Durable path (project or session store) to the scout's report artifact.
     * Required and non-empty — a scout with no report is INCOMPLETE, fail-closed.
     */
    reportPath: z.string().trim().min(1)
  })
  .strict();

export const TaskCompletionSchema = z.discriminatedUnion("shape", [ShipCompletionSchema, ScoutCompletionSchema]);
export type ShipCompletion = z.infer<typeof ShipCompletionSchema>;
export type ScoutCompletion = z.infer<typeof ScoutCompletionSchema>;
export type TaskCompletion = z.infer<typeof TaskCompletionSchema>;

/**
 * Discriminated on `complete`: when incomplete, `reason` is ALWAYS present (the
 * manager surfaces it verbatim); when complete, there is no reason. This keeps
 * `exactOptionalPropertyTypes` honest — an incomplete check never has a missing why.
 */
export type CompletionCheck = { readonly complete: true } | { readonly complete: false; readonly reason: string };

/**
 * Fail-closed completion gate. A shape with no completion evidence, or evidence
 * that does not satisfy its own requirements, is INCOMPLETE. This is the single
 * structural choke point — the manager calls it before marking any worker done.
 */
export function evaluateCompletion(shape: TaskShape, completion: TaskCompletion | undefined): CompletionCheck {
  if (!completion) {
    return {
      complete: false,
      reason:
        shape === "scout"
          ? "scout left no durable report — dispatch is not done"
          : "ship recorded no verification notes and no operator skip"
    };
  }
  if (completion.shape !== shape) {
    return {
      complete: false,
      reason: `completion evidence is for shape '${completion.shape}' but the worker is a '${shape}'`
    };
  }
  if (shape === "scout") {
    // reportPath is schema-enforced non-empty; the discriminated union already
    // guarantees presence here. Anything that reached this point is satisfied.
    return { complete: true };
  }
  // ship: verification notes OR an explicit operator skip.
  const ship = completion as ShipCompletion;
  if (ship.operatorSkip === true) {
    return { complete: true };
  }
  if (typeof ship.verificationNotes === "string" && ship.verificationNotes.trim().length > 0) {
    return { complete: true };
  }
  return { complete: false as const, reason: "ship recorded no verification notes and no operator skip" };
}

/**
 * Structural guard for the plan's "scouts cannot register write tools." A scout is
 * read-oriented by construction; this predicate is the single source of truth the
 * tool-offering layer uses so a scout is never offered a mutation tool.
 */
export function shapePermitsWriteTools(shape: TaskShape): boolean {
  return shape === "ship";
}

/**
 * Resolve the effective task shape for a spawn. Precedence (plan IDEA-A2 §1):
 *  1. An explicitly supplied shape always wins.
 *  2. A read-only / explore worker (mode "read-only") defaults to `scout` — the new
 *     spawn API treats read-oriented workers as scouts that must leave a report.
 *  3. Otherwise `ship` — the backward-compatible default for mutation-capable workers.
 */
export function resolveTaskShape(explicit: TaskShape | undefined, mode: "read-only" | "all"): TaskShape {
  if (explicit) {
    return explicit;
  }
  return mode === "read-only" ? "scout" : "ship";
}
