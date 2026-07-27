import { z } from "zod";

/**
 * Subagent parallel access policy (IDEA-F148-SUBAGENT-ACCESS-01).
 *
 * Pure allow-table for spawn options: declares which tools and which models
 * a subagent (swarm worker) is permitted to use when running in parallel.
 * Unknown tools/models are denied by construction. The policy is immutable
 * after creation and carries no runner or side effects — it is a simple
 * decision table consulted at spawn/execution time.
 *
 * Follows the same encapsulation and freeze patterns as PlanModePolicy and
 * SwarmConfig: private state via WeakMap, defensive copy + freeze on export,
 * early validation with precise error messages.
 */

const AllowedToolIdSchema = z.string().trim().min(1);
const AllowedModelIdSchema = z.string().trim().min(1);

export interface SubagentAccessPolicy {
  /** Returns true only if the tool id is in the allow table. */
  canUseTool(toolId: string): boolean;
  /** Returns true only if the model id is in the allow table. */
  canUseModel(modelId: string): boolean;
  /** Frozen snapshot of the tool allow table (sorted for determinism). */
  readonly allowedTools: readonly string[];
  /** Frozen snapshot of the model allow table (sorted for determinism). */
  readonly allowedModels: readonly string[];
}

const policyState = new WeakMap<
  SubagentAccessPolicy,
  { readonly tools: ReadonlySet<string>; readonly models: ReadonlySet<string> }
>();

/**
 * Create an immutable subagent access policy from explicit allow tables.
 * Duplicates are rejected; empty tables are allowed (policy denies everything).
 */
export function createSubagentAccessPolicy(
  allowedTools: readonly string[] = [],
  allowedModels: readonly string[] = []
): SubagentAccessPolicy {
  // Validate and normalize (trim, unique, sorted for stable snapshots)
  const toolIds = allowedTools
    .map((id) => AllowedToolIdSchema.parse(id))
    .sort((a, b) => a.localeCompare(b));
  const modelIds = allowedModels
    .map((id) => AllowedModelIdSchema.parse(id))
    .sort((a, b) => a.localeCompare(b));

  const toolSet = new Set(toolIds);
  const modelSet = new Set(modelIds);

  if (toolSet.size !== toolIds.length) {
    throw new Error("Duplicate tool ids are not permitted in the subagent access allow table.");
  }
  if (modelSet.size !== modelIds.length) {
    throw new Error("Duplicate model ids are not permitted in the subagent access allow table.");
  }

  const policy: SubagentAccessPolicy = {
    canUseTool(toolId: string): boolean {
      const state = policyState.get(this);
      if (!state) return false;
      return state.tools.has(AllowedToolIdSchema.parse(toolId));
    },
    canUseModel(modelId: string): boolean {
      const state = policyState.get(this);
      if (!state) return false;
      return state.models.has(AllowedModelIdSchema.parse(modelId));
    },
    allowedTools: Object.freeze(toolIds),
    allowedModels: Object.freeze(modelIds)
  };

  policyState.set(policy, {
    tools: toolSet,
    models: modelSet
  });

  return Object.freeze(policy);
}

/** Helper to obtain a human-readable summary for diagnostics / logs. */
export function describeSubagentAccessPolicy(policy: SubagentAccessPolicy): string {
  const state = policyState.get(policy);
  if (!state) return "invalid-subagent-access-policy";
  return `tools=${policy.allowedTools.length} models=${policy.allowedModels.length}`;
}
