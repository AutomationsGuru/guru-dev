import { z } from "zod";

import type { ToolDefinition } from "../registry.js";
import {
  compileFinalJsonSchema,
  validateFinalJson,
  type FinalJsonSchema,
  type FinalJsonValidationError
} from "../finalOutput/validateFinalJson.js";

/**
 * `final_output` tool (Work IDEA-F36-FINAL-JSON-01).
 *
 * Standalone terminal-output tool: requires the model's final answer to be a
 * JSON value matching an *optional* schema. On mismatch it returns structured
 * field-level errors **once** so the caller can drive a single repair turn;
 * a second failure does not get a third chance — the tool fail-closes and the
 * caller (workflow, pack, or ad-hoc loop) owns what happens next.
 *
 * The repair budget lives in the input (`attempt`), not in hidden state, so the
 * tool stays stateless and usable outside a full workflow pack: any caller can
 * pass `attempt: 2` to represent "this is the model's corrected answer after
 * seeing the first error set."
 */

/** Reason the tool returned a structured (non-thrown) outcome. */
export type FinalOutputOutcome = "accepted" | "needs_repair" | "closed";

const FinalOutputOutcomeSchema = z.enum(["accepted", "needs_repair", "closed"]);

export const FinalOutputToolInputSchema = z
  .object({
    /** The model's terminal answer. Must be a JSON value. */
    value: z.unknown(),
    /**
     * Optional JSON-Schema-flavored subset (see {@link FinalJsonSchema}). When
     * omitted, any JSON value is accepted.
     */
    schema: z.unknown().optional(),
    /**
     * 1-based attempt counter. 1 = first answer; 2 = one allowed repair turn.
     * 3+ = past the repair budget; the tool fail-closes regardless of value
     * validity so the caller cannot silently retry forever.
     */
    attempt: z.number().int().min(1).max(8).default(1)
  })
  .strict();

export const FinalOutputToolOutputSchema = z.object({
  outcome: FinalOutputOutcomeSchema,
  ok: z.boolean(),
  attempt: z.number().int(),
  /** True when `attempt` has consumed the single allowed repair turn. */
  repairBudgetExhausted: z.boolean(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
  summary: z.string()
});

export type FinalOutputToolInput = z.infer<typeof FinalOutputToolInputSchema>;
export type FinalOutputToolOutput = z.infer<typeof FinalOutputToolOutputSchema>;

/** One repair turn, then fail-closed. Hard-coded so YOLO or a loop cannot lift it. */
export const FINAL_OUTPUT_MAX_REPAIR_ATTEMPTS = 2;

export function createFinalOutputTool(): ToolDefinition<
  typeof FinalOutputToolInputSchema,
  typeof FinalOutputToolOutputSchema
> {
  return {
    id: "final_output",
    title: "Final structured output",
    description:
      "Accept a model's final answer as JSON matching an optional schema. Returns structured field errors once for a single repair turn, then fail-closes.",
    inputSchema: FinalOutputToolInputSchema,
    outputSchema: FinalOutputToolOutputSchema,
    effect: "read-only",
    execute(input) {
      const attempt = input.attempt;
      const pastRepairBudget = attempt > FINAL_OUTPUT_MAX_REPAIR_ATTEMPTS;

      // 1. A bad schema is a caller bug, not a model answer to repair.
      let compiledSchema: FinalJsonSchema | undefined;
      if (input.schema !== undefined) {
        const schemaResult = safeCompileSchema(input.schema);
        if (!schemaResult.ok) {
          return materialize({
            outcome: "closed",
            ok: false,
            attempt,
            repairBudgetExhausted: pastRepairBudget,
            errors: schemaResult.errors,
            summary: "Closed: invalid final-output schema (caller bug, not repairable by the model)."
          });
        }
        compiledSchema = schemaResult.schema;
      }

      // 2. Past the repair budget, fail-closed even on a valid value: the
      //    caller cannot keep retrying silently. This is the hard edge.
      if (pastRepairBudget) {
        return materialize({
          outcome: "closed",
          ok: false,
          attempt,
          repairBudgetExhausted: true,
          errors: [],
          summary: `Closed: attempt ${attempt} exceeds the ${FINAL_OUTPUT_MAX_REPAIR_ATTEMPTS}-attempt repair budget; caller must stop retrying.`
        });
      }

      // 3. Validate the value.
      const result = validateFinalJson(input.value, compiledSchema);
      if (result.ok) {
        return materialize({
          outcome: "accepted",
          ok: true,
          attempt,
          repairBudgetExhausted: false,
          errors: [],
          summary: "Accepted: final output is valid JSON matching the schema."
        });
      }

      // 4. Invalid value within budget: surface errors once for a repair turn.
      const remaining = FINAL_OUTPUT_MAX_REPAIR_ATTEMPTS - attempt;
      const nextAttemptWillClose = remaining <= 0;
      return materialize({
        outcome: nextAttemptWillClose ? "closed" : "needs_repair",
        ok: false,
        attempt,
        repairBudgetExhausted: nextAttemptWillClose,
        errors: result.errors.map((error) => ({ ...error })),
        summary: nextAttemptWillClose
          ? "Closed: final output invalid and repair budget is now exhausted."
          : `Needs repair: final output invalid; ${remaining} repair attempt(s) remaining.`
      });
    }
  };
}

type CompiledSchema =
  | { ok: true; schema: FinalJsonSchema }
  | { ok: false; errors: FinalJsonValidationError[] };

function safeCompileSchema(raw: unknown): CompiledSchema {
  try {
    compileFinalJsonSchema(raw as FinalJsonSchema);
    return { ok: true, schema: raw as FinalJsonSchema };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ path: "schema", message }] };
  }
}

function materialize(output: FinalOutputToolOutput): FinalOutputToolOutput {
  return {
    ...output,
    errors: output.errors.map((error) => ({ ...error }))
  };
}
