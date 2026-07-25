import { z } from "zod";

/**
 * Composite edit-and-check plan builder (IDEA-F168-EDIT-CHECK-01 / R-ZG-EDITCHECK).
 *
 * Describes a multi-step tool plan that first applies an edit and then runs a
 * check command, without executing either step. The result is a typed plan
 * structure callers (e.g. the agent loop, a tool pack, an IDE adapter) can
 * inspect, persist, surface to the operator, or hand off to an executor.
 *
 * Construction is structural and fail-closed: an empty or whitespace-only
 * `edit` description is rejected synchronously, so a downstream caller never
 * receives a no-op edit step it might silently treat as a success.
 */

// --- Schemas --------------------------------------------------------------

/**
 * One step in a composite tool plan. `kind` distinguishes the only two kinds
 * this builder emits; future kinds (e.g. `"verify"`, `"rollback"`) belong in
 * a separate builder rather than retrofitted here.
 */
export const CompositePlanStepSchema = z
  .object({
    kind: z.enum(["edit", "check"]),
    /** Stable id for the step within a plan; order is preserved by array position. */
    id: z.string().min(1),
    /** Human-readable label suitable for UI/operator surfacing. */
    label: z.string().min(1),
    /** Edit payload (when kind === "edit") — structured, no shell execution. */
    edit: z
      .object({
        path: z.string().trim().min(1),
        mode: z.enum(["overwrite", "createOnly", "exactReplace"]),
        summary: z.string().trim().min(1)
      })
      .strict()
      .optional(),
    /** Check payload (when kind === "check") — the command string to run later. */
    check: z
      .object({
        command: z.string().trim().min(1),
        /** Optional working directory; relative paths are resolved by the executor. */
        cwd: z.string().optional(),
        /** Optional timeout hint (ms) for the executor. */
        timeoutMs: z.number().int().positive().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const CompositePlanSchema = z
  .object({
    /** Stable plan id; defaults to a generated id when not provided. */
    id: z.string().min(1),
    /** Ordered steps: edit step first, then check step. Position enforces order. */
    steps: z.array(CompositePlanStepSchema).min(1),
    /** Marks the plan as a build-time description; no execution occurs here. */
    describesOnly: z.literal(true)
  })
  .strict();

export type CompositePlanStep = z.infer<typeof CompositePlanStepSchema>;
export type CompositePlan = z.infer<typeof CompositePlanSchema>;

// --- Inputs ---------------------------------------------------------------

export const CompositeEditInputSchema = z
  .object({
    path: z.string().trim().min(1),
    mode: z.enum(["overwrite", "createOnly", "exactReplace"]),
    summary: z.string().trim().min(1)
  })
  .strict();

export const CompositeCheckInputSchema = z
  .object({
    command: z.string().trim().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional()
  })
  .strict();

export type CompositeEditInput = z.infer<typeof CompositeEditInputSchema>;
export type CompositeCheckInput = z.infer<typeof CompositeCheckInputSchema>;

// --- Builder --------------------------------------------------------------

export interface BuildPlanOptions {
  /**
   * Optional plan id; auto-generated when omitted. Useful when a caller wants
   * to thread the plan id through other subsystems (logs, persistence).
   */
  readonly id?: string;
}

export class EmptyCompositeEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyCompositeEditError";
  }
}

/**
 * Build a typed composite edit-and-check plan.
 *
 * The edit is intentionally validated beyond `CompositeEditInputSchema` (which
 * already requires a non-empty `summary`) by also rejecting whitespace-only
 * `summary` content after trim, and by re-checking that all three edit fields
 * survive trimming. This keeps a downstream caller from receiving a step that
 * could be silently treated as a no-op.
 *
 * The returned plan is structurally a "describes only" artifact: this builder
 * does not apply the edit or execute the check command. Execution is the
 * responsibility of the registered tool that consumes this plan.
 */
export function buildPlan(
  edit: CompositeEditInput,
  checkCmd: CompositeCheckInput,
  options: BuildPlanOptions = {}
): CompositePlan {
  const editParsed = CompositeEditInputSchema.safeParse(edit);
  if (!editParsed.success) {
    throw new EmptyCompositeEditError(
      `Composite edit rejected: ${editParsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  const checkParsed = CompositeCheckInputSchema.safeParse(checkCmd);
  if (!checkParsed.success) {
    throw new Error(
      `Composite check rejected: ${checkParsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`
    );
  }

  // Belt-and-braces: the schemas already reject empty/whitespace, but make the
  // fail-closed contract obvious at the call site and in test coverage.
  if (editParsed.data.path.trim() === "" || editParsed.data.summary.trim() === "") {
    throw new EmptyCompositeEditError("Composite edit rejected: edit must have a non-empty path and summary.");
  }

  const steps: CompositePlanStep[] = [
    {
      kind: "edit",
      id: "step.edit",
      label: `Edit ${editParsed.data.path} (${editParsed.data.mode})`,
      edit: {
        path: editParsed.data.path,
        mode: editParsed.data.mode,
        summary: editParsed.data.summary
      }
    },
    {
      kind: "check",
      id: "step.check",
      label: `Run check: ${checkParsed.data.command}`,
      check: {
        command: checkParsed.data.command,
        cwd: checkParsed.data.cwd,
        timeoutMs: checkParsed.data.timeoutMs
      }
    }
  ];

  const plan: CompositePlan = {
    id: options.id ?? generatePlanId(),
    steps,
    describesOnly: true
  };

  // Re-parse through the public schema so the builder never returns a value
  // that does not round-trip through `CompositePlanSchema`.
  const reparsed = CompositePlanSchema.parse(plan);
  return reparsed;
}

/**
 * Stable, readable plan id — short enough to fit in logs, unique enough to
 * not collide within a single agent turn. Not a security token.
 */
function generatePlanId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `composite-${stamp}-${random}`;
}
