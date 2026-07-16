import type { ToolExecutionContext, ToolObservation, ToolRegistry } from "../tools/registry.js";
import { executeRegisteredTool } from "../tools/registry.js";
import type { MandateDecision } from "../mandates/evaluate.js";
import type { HarnessSession } from "../runtime/schemas.js";
import {
  PlannerModelRequestSchema,
  PlannerModelResultSchema,
  PlannerPlanSchema,
  PlannerRunOptionsSchema,
  PlannerRunReportSchema,
  PlannerTokenUsageSchema,
  type PlannerFailureReason,
  type PlannerModelRequest,
  type PlannerPlan,
  type PlannerRunOptions,
  type PlannerRunReport,
  type PlannerStepObservation,
  type PlannerTokenUsage
} from "./schemas.js";

export interface PlannerModel {
  createPlan(request: PlannerModelRequest): Promise<unknown> | unknown;
}

export interface RunPlannerExecutionOptions {
  readonly session: HarnessSession;
  readonly registry: ToolRegistry;
  readonly model: PlannerModel;
  readonly objective: string;
  readonly maxSteps?: number;
  /**
   * Mandate floor (ADR 2026-07-05). When set, each planner step is evaluated
   * BEFORE the registry call and a non-allow decision BLOCKS the step — so the
   * mandate applies to planner-driven tool calls too, not just executeTool.
   */
  readonly mandatePolicy?: (toolId: string, input: unknown, cwd: string) => MandateDecision | null;
}

const PLANNER_STARTED_BY = "guruharness-planner-runtime";

export async function runPlannerExecution(options: RunPlannerExecutionOptions): Promise<PlannerRunReport> {
  const startedAtDate = new Date();
  const parsedOptions = PlannerRunOptionsSchema.parse({
    objective: options.objective,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {})
  });
  const observations: PlannerStepObservation[] = [];
  const blockers: string[] = [];
  let plan: PlannerPlan | null = null;
  let usage: PlannerTokenUsage | undefined;

  const request = PlannerModelRequestSchema.parse({
    objective: parsedOptions.objective,
    session: options.session,
    tools: options.registry.list().map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description
    }))
  });

  try {
    const modelResult = await options.model.createPlan(request);
    const envelopeResult = PlannerModelResultSchema.safeParse(modelResult);
    const rawPlan = envelopeResult.success ? envelopeResult.data.plan : modelResult;
    usage = envelopeResult.success ? envelopeResult.data.usage : undefined;
    const planResult = PlannerPlanSchema.safeParse(rawPlan);

    if (!planResult.success) {
      blockers.push(`Planner model returned an invalid plan: ${planResult.error.issues.map(formatIssue).join("; ")}`);

      return buildPlannerRunReport(options.session.id, parsedOptions.objective, startedAtDate, plan, observations, blockers, "invalid-plan", usage);
    }

    plan = planResult.data;
  } catch (error) {
    blockers.push(`Planner model failed: ${formatError(error)}`);

    return buildPlannerRunReport(
      options.session.id,
      parsedOptions.objective,
      startedAtDate,
      plan,
      observations,
      blockers,
      "model-threw",
      extractPlannerErrorUsage(error)
    );
  }

  if (plan.steps.length > parsedOptions.maxSteps) {
    blockers.push(`Planner produced ${plan.steps.length} step(s), exceeding maxSteps ${parsedOptions.maxSteps}.`);

    return buildPlannerRunReport(options.session.id, parsedOptions.objective, startedAtDate, plan, observations, blockers, "invalid-plan", usage);
  }

  const cwd = options.session.repo?.repoRoot ?? process.cwd();
  for (const step of plan.steps) {
    if (!options.registry.get(step.toolId)) {
      blockers.push(`Planner step ${step.id} references unregistered tool: ${step.toolId}`);
      break;
    }

    // Mandate floor: a blocked step NEVER reaches the registry.
    if (options.mandatePolicy) {
      const decision = options.mandatePolicy(step.toolId, step.input, cwd);
      if (decision && decision.outcome !== "allow") {
        blockers.push(`Planner step ${step.id} blocked by mandate: ${decision.reason} (verbs: ${decision.verbs.join("+") || "none"}).`);
        break;
      }
    }

    const observation = await executeRegisteredTool(options.registry, step.toolId, step.input, createPlannerToolContext(options.session));
    observations.push({ step, observation: observation as ToolObservation });

    if (observation.status === "failed") {
      blockers.push(`Planner step ${step.id} failed: ${observation.error ?? "unknown error"}`);
      break;
    }
  }

  return buildPlannerRunReport(
    options.session.id,
    parsedOptions.objective,
    startedAtDate,
    plan,
    observations,
    blockers,
    blockers.length > 0 ? "tool-failed" : undefined,
    usage
  );
}

export function createBlockedPlannerRunReport(
  sessionId: string,
  options: PlannerRunOptions,
  blocker: string,
  failureReason: PlannerFailureReason = "unknown"
): PlannerRunReport {
  const startedAtDate = new Date();
  const parsedOptions = PlannerRunOptionsSchema.parse(options);

  return buildPlannerRunReport(sessionId, parsedOptions.objective, startedAtDate, null, [], [blocker], failureReason);
}

function createPlannerToolContext(session: HarnessSession): ToolExecutionContext {
  return {
    runId: session.id,
    ...(session.repo ? { cwd: session.repo.repoRoot } : {}),
    startedBy: PLANNER_STARTED_BY,
    metadata: {
      ...(session.task ? { taskId: session.task.id } : {}),
      runtimeName: session.runtimeName,
      planner: true
    }
  };
}

function buildPlannerRunReport(
  sessionId: string,
  objective: string,
  startedAtDate: Date,
  plan: PlannerPlan | null,
  observations: readonly PlannerStepObservation[],
  blockers: readonly string[],
  failureReason?: PlannerFailureReason,
  usage?: PlannerTokenUsage
): PlannerRunReport {
  const endedAtDate = new Date();
  const status = blockers.length === 0 ? "completed" : "blocked";

  return PlannerRunReportSchema.parse({
    sessionId,
    objective,
    status,
    ...(status === "blocked" && failureReason ? { failureReason } : {}),
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: Math.max(0, endedAtDate.getTime() - startedAtDate.getTime()),
    plan,
    ...(usage ? { usage } : {}),
    observations,
    blockers: [...blockers],
    nextActions:
      status === "completed"
        ? ["Inspect planner observations, then run validation and review gates before handoff."]
        : ["Resolve planner blocker(s), then rerun the planner with an updated objective or model output."]
  });
}

function extractPlannerErrorUsage(error: unknown): PlannerTokenUsage | undefined {
  if (typeof error !== "object" || error === null || !("usage" in error)) {
    return undefined;
  }

  const result = PlannerTokenUsageSchema.safeParse((error as { readonly usage?: unknown }).usage);
  return result.success ? result.data : undefined;
}

function formatIssue(issue: { readonly path: readonly PropertyKey[]; readonly message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";

  return `${path}: ${issue.message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
