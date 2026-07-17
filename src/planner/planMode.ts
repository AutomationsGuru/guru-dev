import { z } from "zod";

import { createToolRegistry, executeRegisteredTool } from "../tools/registry.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolObservation,
  ToolRegistry
} from "../tools/registry.js";

const AffectedPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), {
    message: "Affected paths must not contain NUL characters."
  })
  .refine((value) => !/(^|[\\/])\.\.([\\/]|$)/.test(value), {
    message: "Affected paths must not contain path traversal segments."
  });

export const PlanModeDraftSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    assumptions: z.array(z.string().trim().min(1)),
    steps: z
      .array(
        z
          .object({
            order: z.number().int().positive(),
            description: z.string().trim().min(1)
          })
          .strict()
      )
      .min(1)
      .superRefine((steps, context) => {
        steps.forEach((step, index) => {
          if (step.order !== index + 1) {
            context.addIssue({
              code: "custom",
              path: [index, "order"],
              message: "Step order must match its one-based position."
            });
          }
        });
      }),
    affectedPaths: z.array(AffectedPathSchema),
    validation: z.array(z.string().trim().min(1)),
    unresolvedQuestions: z.array(z.string().trim().min(1))
  })
  .strict()
  .superRefine((draft, context) => {
    if (JSON.stringify(draft).length > 20_000) {
      context.addIssue({
        code: "custom",
        message: "Plan draft exceeds the maximum serialized size of 20000 characters."
      });
    }
  });

export type PlanModeDraft = z.infer<typeof PlanModeDraftSchema>;

export type PlanModeDraftResult =
  | { readonly ok: true; readonly draft: PlanModeDraft }
  | { readonly ok: false; readonly error: string };

export function parsePlanModeDraft(input: unknown): PlanModeDraftResult {
  const result = PlanModeDraftSchema.safeParse(input);

  if (result.success) {
    return { ok: true, draft: result.data };
  }

  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
      .join("; ")
  };
}

export interface PlanModePolicy {
  getTool(toolId: string): ToolDefinition | undefined;
  listTools(): readonly ToolDefinition[];
}

const planModePolicyStates = new WeakMap<PlanModePolicy, { readonly registry: ToolRegistry }>();

export function createPlanModePolicy(registry: ToolRegistry, readOnlyToolIds: readonly string[]): PlanModePolicy {
  if (readOnlyToolIds.length === 0) {
    throw new Error("Plan mode requires at least one read-only tool id.");
  }

  const uniqueToolIds = new Set<string>();
  for (const toolId of readOnlyToolIds) {
    if (uniqueToolIds.has(toolId)) {
      throw new Error(`Duplicate plan-mode read-only tool id: ${toolId}`);
    }
    uniqueToolIds.add(toolId);
  }

  const definitions = Object.freeze(
    readOnlyToolIds.map((toolId) => {
      const definition = registry.get(toolId);

      if (!definition) {
        throw new Error(`Plan-mode read-only tool is not registered: ${toolId}`);
      }

      return definition;
    })
  );
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));

  const policy: PlanModePolicy = Object.freeze({
    getTool(toolId: string) {
      return definitionsById.get(toolId);
    },
    listTools() {
      return definitions;
    }
  });

  planModePolicyStates.set(policy, { registry });

  return policy;
}

/**
 * The canonical plan-mode read-only surface (G1004 runtime gate), in registry
 * (alphabetical) order. Frozen so a caller cannot enlarge the default tuple.
 * Only ids whose registered definition explicitly declares `effect === "read-only"`
 * are certified into a live policy; the rest are rejected even if listed here.
 */
export const PLAN_MODE_DEFAULT_TOOL_IDS: readonly ["glob", "grep", "ls", "read"] = Object.freeze([
  "glob",
  "grep",
  "ls",
  "read"
]);

/**
 * Build a session plan-mode policy by certifying only tools whose definition
 * carries `effect === "read-only"`. Unmarked or explicitly mutating definitions
 * are rejected even when their id is in the candidate allowlist. Each certified
 * definition (and its executor) is snapshotted into a private frozen registry so
 * later mutation of the source definitions or registration on the source
 * registry cannot enlarge or replace the plan-mode surface. Delegates the frozen
 * allowlist view to {@link createPlanModePolicy}.
 */
export function createCertifiedPlanModePolicy(
  sourceRegistry: ToolRegistry,
  candidateToolIds: readonly string[] = PLAN_MODE_DEFAULT_TOOL_IDS
): PlanModePolicy {
  const seen = new Set<string>();
  const certified: ToolDefinition[] = [];

  for (const toolId of candidateToolIds) {
    if (seen.has(toolId)) {
      continue;
    }
    seen.add(toolId);

    const definition = sourceRegistry.get(toolId);

    if (!definition) {
      continue; // not registered → not certified
    }
    if (definition.effect !== "read-only") {
      continue; // unmarked or mutating → rejected even when allowlisted
    }

    // Shallow-copy then freeze: captures the executor reference at certification
    // time and prevents later reassignment from replacing the frozen executor.
    certified.push(Object.freeze({ ...definition }));
  }

  certified.sort((left, right) => left.id.localeCompare(right.id));

  // Private frozen registry: a distinct ToolRegistry the session never reaches,
  // so post-policy registration/mutation on the source registry cannot leak in.
  const frozenRegistry = createToolRegistry(certified);

  return createPlanModePolicy(frozenRegistry, certified.map((definition) => definition.id));
}

export async function executePlanModeTool(
  policy: PlanModePolicy,
  toolId: string,
  input: unknown,
  context: ToolExecutionContext = {}
): Promise<ToolObservation> {
  const state = planModePolicyStates.get(policy);

  if (!state) {
    throw new Error("Invalid plan-mode policy.");
  }

  if (!state.registry.get(toolId)) {
    throw new Error(`Plan-mode tool is not registered: ${toolId}`);
  }

  if (!policy.getTool(toolId)) {
    throw new Error(`Tool is not allowlisted for plan mode: ${toolId}`);
  }

  return executeRegisteredTool(state.registry, toolId, input, context);
}
