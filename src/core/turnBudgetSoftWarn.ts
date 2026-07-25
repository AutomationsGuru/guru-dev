import { z } from "zod";

export const TurnBudgetSoftWarnInputSchema = z
  .object({
    remaining: z.number().finite().nonnegative(),
    softPct: z.number().finite().nonnegative()
  })
  .strict();
export type TurnBudgetSoftWarnInput = z.infer<typeof TurnBudgetSoftWarnInputSchema>;

/**
 * Returns true when `remaining` has crossed (at or below) the soft-warning
 * threshold. Both values are in the same unit — typically the caller converts a
 * configured percentage into an absolute count before calling, e.g.:
 *
 *   shouldSoftWarn(toolBudget, Math.floor(maxToolCalls * 0.2))
 *
 * The function itself is unit-agnostic; "softPct" is named for the convention
 * that the threshold is derived from a percentage of the original budget.
 */
export function shouldSoftWarn(remaining: number, softPct: number): boolean {
  const parsed = TurnBudgetSoftWarnInputSchema.safeParse({ remaining, softPct });

  if (!parsed.success) {
    throw new Error(
      `Invalid turn-budget soft-warn input: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }

  return parsed.data.remaining <= parsed.data.softPct;
}
