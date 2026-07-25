import { z } from "zod";

/**
 * Task human-input compose gate.
 *
 * A task flagged `humanInput: true` must not auto-complete: completion is
 * blocked until a valid human receipt is presented. A receipt proves a human
 * acknowledged the task's outcome. When the flag is false or absent, the
 * receipt is irrelevant and completion is allowed.
 */

export const HumanInputTaskSchema = z
  .object({
    humanInput: z.boolean().optional()
  })
  .passthrough();
export type HumanInputTask = z.infer<typeof HumanInputTaskSchema>;

export const HumanReceiptSchema = z
  .object({
    receivedBy: z.string().trim().min(1),
    receivedAt: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1).optional()
  })
  .strict();
export type HumanReceipt = z.infer<typeof HumanReceiptSchema>;

export type CanCompleteResult = { allowed: true } | { allowed: false; reason: string };

const BLOCKED_REASON =
  "Task requires human input: auto-complete is blocked until a valid human receipt is present.";

/**
 * Decide whether a task may complete.
 *
 * - `humanInput === true` + no/invalid receipt -> blocked with a reason.
 * - `humanInput === true` + valid receipt     -> allowed.
 * - `humanInput` false/absent                 -> allowed regardless of receipt.
 *
 * Never throws on malformed input: an unparseable task is treated as having no
 * `humanInput` flag (allowed), and an unparseable receipt is treated as absent.
 */
export function canComplete(task: unknown, receipt?: unknown): CanCompleteResult {
  const parsedTask = HumanInputTaskSchema.safeParse(task);
  const humanInput = parsedTask.success ? parsedTask.data.humanInput === true : false;

  if (!humanInput) {
    return { allowed: true };
  }

  const parsedReceipt = HumanReceiptSchema.safeParse(receipt);
  if (!parsedReceipt.success) {
    return { allowed: false, reason: BLOCKED_REASON };
  }

  return { allowed: true };
}
