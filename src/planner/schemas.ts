import { z } from "zod";

import { HarnessSessionSchema, RuntimeToolSummarySchema } from "../runtime/schemas.js";

export const PlannerStepSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    toolId: z.string().trim().min(1),
    input: z.unknown()
  })
  .strict();
export type PlannerStep = z.infer<typeof PlannerStepSchema>;

export const PlannerPlanSchema = z
  .object({
    objective: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    steps: z.array(PlannerStepSchema).default([])
  })
  .strict();
export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;

export const PlannerModelRequestSchema = z
  .object({
    objective: z.string().trim().min(1),
    session: HarnessSessionSchema,
    tools: z.array(RuntimeToolSummarySchema)
  })
  .strict();
export type PlannerModelRequest = z.infer<typeof PlannerModelRequestSchema>;

export const PlannerRunOptionsSchema = z
  .object({
    objective: z.string().trim().min(1),
    maxSteps: z.number().int().positive().max(25).default(10)
  })
  .strict();
export type PlannerRunOptions = z.input<typeof PlannerRunOptionsSchema>;
export type ParsedPlannerRunOptions = z.infer<typeof PlannerRunOptionsSchema>;

export const PlannerToolObservationSchema = z
  .object({
    toolId: z.string().trim().min(1),
    status: z.enum(["succeeded", "failed"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().nonnegative().max(86_400_000),
    output: z.unknown().optional(),
    error: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine(assertTimestampOrder);
export type PlannerToolObservation = z.infer<typeof PlannerToolObservationSchema>;

export const PlannerStepObservationSchema = z
  .object({
    step: PlannerStepSchema,
    observation: PlannerToolObservationSchema
  })
  .strict();
export type PlannerStepObservation = z.infer<typeof PlannerStepObservationSchema>;

export const PlannerFailureReasonSchema = z.enum([
  "missing-session",
  "missing-model",
  "invalid-plan",
  "model-threw",
  "tool-failed",
  "unknown"
]);
export type PlannerFailureReason = z.infer<typeof PlannerFailureReasonSchema>;

export const PlannerRunReportSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    status: z.enum(["completed", "blocked"]),
    failureReason: PlannerFailureReasonSchema.optional(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().nonnegative().max(86_400_000),
    plan: PlannerPlanSchema.nullable(),
    observations: z.array(PlannerStepObservationSchema),
    blockers: z.array(z.string()),
    nextActions: z.array(z.string())
  })
  .strict()
  .superRefine(assertTimestampOrder);
export type PlannerRunReport = z.infer<typeof PlannerRunReportSchema>;

function assertTimestampOrder(value: { readonly startedAt: string; readonly endedAt: string }, context: z.RefinementCtx): void {
  const startedAtMs = Date.parse(value.startedAt);
  const endedAtMs = Date.parse(value.endedAt);

  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return;
  }

  if (endedAtMs < startedAtMs) {
    context.addIssue({
      code: "custom",
      path: ["endedAt"],
      message: "endedAt must be greater than or equal to startedAt."
    });
  }
}
