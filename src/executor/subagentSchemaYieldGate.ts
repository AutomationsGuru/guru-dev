/**
 * Subagent schema yield gate. Validates a subagent's yielded result against a
 * caller-supplied zod schema before the value is allowed to flow back into the
 * harness. The gate is a frozen seam: it fails closed — an invalid yield is
 * never returned as data; the failure path either returns `{ ok: false, error }`
 * or throws, mirroring the fail-closed style of createDonePacket. This module is
 * intentionally standalone (no executor imports) so subagent dispatch can adopt
 * it without pulling in executor wiring.
 */
import type { ZodType } from "zod";

/** Successful yield validation: `value` is the schema-parsed output (not raw input). */
export interface YieldValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed yield validation: `error` is the joined zod issue messages. */
export interface YieldValidationFailure {
  readonly ok: false;
  readonly error: string;
}

export type YieldValidationResult<T> = YieldValidationSuccess<T> | YieldValidationFailure;

/**
 * Validates `result` against `schema` via safeParse. On success returns
 * `{ ok: true, value }` with the parsed (transformed/defaulted) data; on failure
 * returns `{ ok: false, error }` with issue messages joined by "; ". Fails
 * closed: unvalidated data is never returned.
 */
export function validateYield<T>(result: unknown, schema: ZodType<T>): YieldValidationResult<T> {
  const parsed = schema.safeParse(result);

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join("; ")
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * Fail-closed convenience over {@link validateYield}: returns the parsed value
 * on success, throws `Error("Invalid subagent yield: ...")` on failure.
 */
export function assertYieldValid<T>(result: unknown, schema: ZodType<T>): T {
  const validation = validateYield(result, schema);

  if (!validation.ok) {
    throw new Error(`Invalid subagent yield: ${validation.error}`);
  }

  return validation.value;
}
