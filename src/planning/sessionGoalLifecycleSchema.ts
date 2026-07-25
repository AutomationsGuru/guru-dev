import { z } from "zod";

export const SessionGoalStatusSchema = z.enum(["active", "paused", "completed", "blocked"]);
export type SessionGoalStatus = z.infer<typeof SessionGoalStatusSchema>;

export const SessionGoalAcceptanceCriterionSchema = z
  .object({
    id: z.string().trim().min(1),
    text: z.string().trim().min(1),
    accepted: z.boolean()
  })
  .strict();
export type SessionGoalAcceptanceCriterion = z.infer<typeof SessionGoalAcceptanceCriterionSchema>;

export const SessionGoalSchema = z
  .object({
    id: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    acceptanceCriteria: z.array(SessionGoalAcceptanceCriterionSchema),
    status: SessionGoalStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
export type SessionGoal = z.infer<typeof SessionGoalSchema>;

export const SessionGoalDraftSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();
export type SessionGoalDraft = z.infer<typeof SessionGoalDraftSchema>;

export const SessionGoalAmendmentSchema = z
  .object({
    objective: z.string().trim().min(1).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).optional(),
    status: z.enum(["active", "paused", "blocked"]).optional()
  })
  .strict()
  .superRefine((amendment, context) => {
    if (
      amendment.objective === undefined &&
      amendment.acceptanceCriteria === undefined &&
      amendment.status === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Amendment must change at least one of objective, acceptanceCriteria, or status."
      });
    }
  });
export type SessionGoalAmendment = z.infer<typeof SessionGoalAmendmentSchema>;
