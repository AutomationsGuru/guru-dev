import { z } from "zod";

/**
 * Workflow dry-run: walk steps without side effects; return planned actions.
 *
 * dryRun(steps) validates every step, detects duplicates and missing fields,
 * and reports what WOULD execute — without ever calling a tool, spawning a
 * process, or mutating state.  The result is a read-only preview of the
 * workflow plan.
 */

// ── Schemas ────────────────────────────────────────────────────────────────

export const WorkflowStepSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    toolId: z.string().trim().min(1),
    input: z.unknown()
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const PlannedActionStatusSchema = z.enum(["will-run", "blocked"]);
export type PlannedActionStatus = z.infer<typeof PlannedActionStatusSchema>;

export const PlannedActionSchema = z
  .object({
    stepId: z.string().trim().min(1),
    stepTitle: z.string().trim().min(1),
    toolId: z.string().trim().min(1),
    status: PlannedActionStatusSchema,
    reason: z.string().trim().min(1)
  })
  .strict();
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

export const WorkflowDryRunResultSchema = z
  .object({
    steps: z.array(WorkflowStepSchema),
    plannedActions: z.array(PlannedActionSchema),
    summary: z.string().trim().min(1),
    totalSteps: z.number().int().nonnegative(),
    willRunCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.totalSteps !== result.willRunCount + result.blockedCount) {
      ctx.addIssue({
        code: "custom",
        message: "totalSteps must equal willRunCount + blockedCount"
      });
    }
    if (result.totalSteps !== result.plannedActions.length) {
      ctx.addIssue({
        code: "custom",
        message: "totalSteps must equal plannedActions.length"
      });
    }
  });
export type WorkflowDryRunResult = z.infer<typeof WorkflowDryRunResultSchema>;

// ── dryRun ─────────────────────────────────────────────────────────────────

/**
 * Walk `steps` without side effects and return a preview of what WOULD
 * execute.  No tool, executor, subprocess, or I/O is ever invoked.
 *
 * Each step is validated against {@link WorkflowStepSchema}.  Steps that
 * fail validation are reported as `blocked` with the specific reason.
 * Duplicate step IDs are also blocked.
 *
 * @returns A structured dry-run result describing every step's planned action.
 */
export function dryRun(steps: readonly WorkflowStep[]): WorkflowDryRunResult {
  const plannedActions: PlannedAction[] = [];
  const seenIds = new Set<string>();

  for (const step of steps) {
    const parseResult = WorkflowStepSchema.safeParse(step);

    if (!parseResult.success) {
      const messages = parseResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      plannedActions.push({
        stepId: typeof step.id === "string" && step.id.trim().length > 0 ? step.id : "(invalid)",
        stepTitle:
          typeof step.title === "string" && step.title.trim().length > 0
            ? step.title
            : "(invalid)",
        toolId:
          typeof step.toolId === "string" && step.toolId.trim().length > 0
            ? step.toolId
            : "(invalid)",
        status: "blocked",
        reason: `step validation failed: ${messages}`
      });
      continue;
    }

    const valid = parseResult.data;

    if (seenIds.has(valid.id)) {
      plannedActions.push({
        stepId: valid.id,
        stepTitle: valid.title,
        toolId: valid.toolId,
        status: "blocked",
        reason: `duplicate step id "${valid.id}"`
      });
      continue;
    }

    seenIds.add(valid.id);

    plannedActions.push({
      stepId: valid.id,
      stepTitle: valid.title,
      toolId: valid.toolId,
      status: "will-run",
      reason: "step is valid and would execute"
    });
  }

  const willRunCount = plannedActions.filter((a) => a.status === "will-run").length;
  const blockedCount = plannedActions.filter((a) => a.status === "blocked").length;

  const summary =
    blockedCount === 0
      ? `DRY RUN — all ${willRunCount} step(s) would execute; 0 blocked. Nothing was executed.`
      : `DRY RUN — ${willRunCount} step(s) would execute, ${blockedCount} blocked. Nothing was executed.`;

  return {
    steps: steps.filter((s) => {
      const r = WorkflowStepSchema.safeParse(s);
      return r.success;
    }),
    plannedActions,
    summary,
    totalSteps: steps.length,
    willRunCount,
    blockedCount
  };
}
