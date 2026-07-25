import type { ZodType } from "zod";

export type TypedSubagentYield<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: "Subagent yield does not match the requested schema." };

const INVALID_SUBAGENT_YIELD = "Subagent yield does not match the requested schema.";

/**
 * Validates a subagent result before a caller can consume it as a typed yield.
 * Invalid output stays opaque and fails closed rather than becoming a partial result.
 */
export function validateTypedSubagentYield<T>(result: unknown, schema: ZodType<T>): TypedSubagentYield<T> {
  try {
    const parsed = schema.safeParse(result);

    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: INVALID_SUBAGENT_YIELD };
  } catch {
    return { ok: false, error: INVALID_SUBAGENT_YIELD };
  }
}
