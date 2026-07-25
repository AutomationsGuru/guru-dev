import { z } from "zod";

/**
 * Spec packet schema (IDEA-F371-SPEC-01, R-KIRO-SPEC) — a pure shape validator
 * for the `{ goals, constraints, acceptance[] }` spec packet.
 *
 * A spec packet is the intake contract for planned work: what the work must
 * achieve (`goals`), the hard boundaries it must stay inside (`constraints`),
 * and the observable outcomes that prove it is done (`acceptance[]`). It is
 * deliberately pure data — no side effects, no IO — so it can validate an
 * intake before any plan or build begins.
 *
 * The founding thesis this serves: rules that matter are enforced structurally
 * (a schema), not left as prose a model could skip under pressure
 * (prompt-rule drift). An empty `acceptance[]` is rejected here so "done" can
 * never be undefined — the packet must state what proves it.
 */

/** A single observable acceptance criterion that proves the work is done. */
export const SpecAcceptanceItemSchema = z
  .object({
    /** Human-readable statement of the outcome this criterion verifies. */
    statement: z.string().trim().min(1).max(2000),
    /**
     * Optional machine- or human-readable check reference (a test name, a
     * command, a gate id). Selection-only; how it runs is the plan's job.
     */
    check: z.string().trim().min(1).max(500).optional()
  })
  .strict();

export type SpecAcceptanceItem = z.infer<typeof SpecAcceptanceItemSchema>;

/**
 * The spec packet itself. `acceptance` is a non-empty array: a spec with no
 * acceptance criteria cannot prove its own completion, so it is invalid by
 * construction.
 */
export const SpecPacketSchema = z
  .object({
    /** What the work must achieve (at least one goal). */
    goals: z.array(z.string().trim().min(1).max(2000)).min(1),
    /** Hard boundaries the work must stay inside; may be empty. */
    constraints: z.array(z.string().trim().min(1).max(2000)).default([]),
    /** Observable outcomes that prove completion — at least one required. */
    acceptance: z.array(SpecAcceptanceItemSchema).min(1)
  })
  .strict();

export type SpecPacket = z.infer<typeof SpecPacketSchema>;

export type SpecValidationError = {
  ok: false;
  /** Flat list of human-readable field errors (zod path → message). */
  errors: string[];
};

export type SpecValidationOk = {
  ok: true;
  /** The normalized, schema-validated packet (defaults applied). */
  packet: SpecPacket;
};

export type SpecValidationResult = SpecValidationOk | SpecValidationError;

/**
 * Validate a spec packet against the `{ goals, constraints, acceptance[] }`
 * shape. Pure: no side effects, no IO. Returns a discriminated result so
 * callers never need to `throw` to learn a packet is malformed.
 *
 * @example
 *   validateSpec({ goals: ["ship X"], constraints: [], acceptance: [{ statement: "X runs" }] })
 *   // → { ok: true, packet: { … } }
 *
 *   validateSpec({ goals: ["ship X"], constraints: [], acceptance: [] })
 *   // → { ok: false, errors: ["acceptance: …must NOT have fewer than 1 items"] }
 */
export function validateSpec(input: unknown): SpecValidationResult {
  const parsed = SpecPacketSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, packet: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}
