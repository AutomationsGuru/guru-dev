import { z } from "zod";

/**
 * Workflow dry-run (IDEA-F431-DRYRUN-01 / R-CN-DRY).
 *
 * Walks a list of planned workflow steps and returns the list of actions that
 * *would* be taken — without ever executing any of them.
 *
 * Structural side-effect freedom is enforced by the type signature, not by
 * prose: {@link dryRunWorkflow} accepts only validated {@link WorkflowStep}
 * descriptors. It accepts **no executor, no tool registry, no execution
 * context, and no callback** of any kind, so there is no parameter through
 * which a caller could cause real work to happen. The function never imports,
 * constructs, or calls an executor. The returned report always carries
 * `executed: false`; every planned action carries `executed: false`.
 */

const WorkflowEffectSchema = z.enum(["read-only", "mutating"]);

export const WorkflowStepSchema = z
  .object({
    /** Stable, unique step identifier within the workflow. */
    id: z.string().trim().min(1),
    /** The tool/capability the step would invoke if executed for real. */
    toolId: z.string().trim().min(1),
    /**
     * Structural effect the step would have if executed. Defaults to
     * `"read-only"` when omitted; an unknown value is rejected so a mutating
     * step can never hide behind an unmarked effect.
     */
    effect: WorkflowEffectSchema.default("read-only"),
    /** Human-readable description of what the step plans to do. */
    description: z.string().trim().min(1),
    /** The input the step would pass to the tool. Opaque; never executed. */
    input: z.unknown().optional(),
    /** Optional rationale for the step, surfaced on the planned action. */
    rationale: z.string().trim().min(1).optional()
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

const PlannedActionSchema = z
  .object({
    stepId: z.string().min(1),
    toolId: z.string().min(1),
    effect: WorkflowEffectSchema,
    description: z.string().min(1),
    /** Whether this step would mutate state *if* it were executed for real. */
    wouldExecute: z.boolean(),
    /** Always false in a dry-run; the step was never run. */
    executed: z.literal(false),
    input: z.unknown().optional(),
    rationale: z.string().min(1).optional()
  })
  .strict();
export type PlannedAction = z.infer<typeof PlannedActionSchema>;

const WorkflowDryRunSummarySchema = z
  .object({
    totalSteps: z.number().int().nonnegative(),
    readOnlyCount: z.number().int().nonnegative(),
    mutatingCount: z.number().int().nonnegative()
  })
  .strict();
export type WorkflowDryRunSummary = z.infer<typeof WorkflowDryRunSummarySchema>;

export const WorkflowDryRunReportSchema = z
  .object({
    /** Always false: a dry-run never executes. */
    executed: z.literal(false),
    actions: z.array(PlannedActionSchema),
    summary: WorkflowDryRunSummarySchema
  })
  .strict();
export type WorkflowDryRunReport = z.infer<typeof WorkflowDryRunReportSchema>;

/**
 * Walk `steps` and return the planned-actions list without side effects.
 *
 * @throws {Error} if two steps share the same `id` (ambiguous plan).
 */
export function dryRunWorkflow(steps: readonly WorkflowStep[]): WorkflowDryRunReport {
  const seen = new Set<string>();
  const actions: PlannedAction[] = [];
  let readOnlyCount = 0;
  let mutatingCount = 0;

  for (const step of steps) {
    // Re-validate defensively: callers may pass values typed as WorkflowStep
    // that bypassed parsing. Validation only — never execution.
    const parsed = WorkflowStepSchema.parse(step);

    if (seen.has(parsed.id)) {
      throw new Error(`Workflow dry-run rejected duplicate step id: ${parsed.id}`);
    }
    seen.add(parsed.id);

    if (parsed.effect === "mutating") {
      mutatingCount += 1;
    } else {
      readOnlyCount += 1;
    }

    // `wouldExecute` describes intent only: would this step mutate state if it
    // were run? It is never used to actually run anything. `executed` is fixed
    // to false by construction (z.literal(false)).
    const action: PlannedAction = {
      stepId: parsed.id,
      toolId: parsed.toolId,
      effect: parsed.effect,
      description: parsed.description,
      wouldExecute: parsed.effect === "mutating",
      executed: false,
      ...(parsed.input !== undefined ? { input: parsed.input } : {}),
      ...(parsed.rationale !== undefined ? { rationale: parsed.rationale } : {})
    };

    actions.push(action);
  }

  return {
    executed: false,
    actions,
    summary: {
      totalSteps: actions.length,
      readOnlyCount,
      mutatingCount
    }
  };
}
