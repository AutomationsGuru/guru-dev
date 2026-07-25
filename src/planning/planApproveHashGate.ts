/**
 * Plan approve hash gate.
 *
 * A plan may execute only against an approval receipt whose approved plan hash
 * equals the hash of the plan being executed. This is a structural,
 * code-enforced gate — not prose — so that mismatched or unapproved plans fail
 * closed at the execute boundary.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const PlanHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "planHash must be a lowercase sha256 hex digest");
export type PlanHash = z.infer<typeof PlanHashSchema>;

export const PlanApproveReceiptSchema = z
  .object({
    planHash: PlanHashSchema,
    approvedAt: z.string().datetime(),
    approver: z.string().trim().min(1)
  })
  .strict();
export type PlanApproveReceipt = z.infer<typeof PlanApproveReceiptSchema>;

export function computePlanHash(planJson: string): PlanHash {
  const hash = createHash("sha256").update(planJson).digest("hex");
  return PlanHashSchema.parse(hash);
}

export function canExecute(planHash: string, receipt: PlanApproveReceipt): boolean {
  if (!PlanHashSchema.safeParse(planHash).success) {
    return false;
  }

  const receiptHashParse = PlanHashSchema.safeParse(
    (receipt as { planHash?: unknown }).planHash
  );
  if (!receiptHashParse.success) {
    return false;
  }

  const a = Buffer.from(planHash, "utf8");
  const b = Buffer.from(receiptHashParse.data, "utf8");
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

export function createPlanApproveReceipt(planHash: string, approver: string): PlanApproveReceipt {
  return PlanApproveReceiptSchema.parse({
    planHash: PlanHashSchema.parse(planHash),
    approvedAt: new Date().toISOString(),
    approver
  });
}
