import { verbsForCall, MANDATE_READ_ONLY_TOOLS } from "../mandates/evaluate.js";
import { HARD_EDGE_VERBS } from "../mandates/schema.js";
import { ROLE_CORE_FLOOR, ROLE_READ_ONLY_FLOOR } from "../roles/schema.js";

export interface AgentRoleGate {
  readonly capabilityMode?: "read-only" | "all";
  readonly tools?: readonly string[];
  readonly verifiedTools?: readonly string[];
}

export interface AgentDefinition {
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly roleGate?: AgentRoleGate;
  // Support direct properties on def for role-like structures
  readonly capabilityMode?: "read-only" | "all";
  readonly tools?: readonly string[];
  readonly verifiedTools?: readonly string[];
}

export interface ToolObject {
  readonly id: string;
  readonly input?: unknown;
}

export type ToolParam = string | ToolObject;

export type AutonomyParam = "auto" | "manual" | "supervised" | boolean;

/**
 * Checks if a tool is mutating (non-read-only).
 */
function isMutatingTool(toolId: string, input?: unknown): boolean {
  if (MANDATE_READ_ONLY_TOOLS.has(toolId)) {
    return false;
  }
  const verbs = verbsForCall(toolId, input);
  if (verbs.length === 0) {
    return false;
  }
  // Mutating verbs: if it has any verb other than 'read', it's mutating.
  return verbs.some((v) => v !== "read");
}

/**
 * Checks if a tool has any hard-limit/hard-edge verbs.
 */
function isHardLimitTool(toolId: string, input?: unknown): boolean {
  const verbs = verbsForCall(toolId, input);
  return verbs.some((v) => HARD_EDGE_VERBS.has(v));
}

/**
 * Evaluates custom agent tool permissions: agent definition allow/deny tool lists
 * intersected with role gate and autonomy risk.
 *
 * @param def The custom agent definition containing allowlist/denylist and optional role/gate constraints.
 * @param tool The tool under evaluation (either its ID string, or an object with ID and inputs).
 * @param autonomy The current autonomy level or boolean flag.
 * @returns true if allowed, false if denied.
 */
export function evaluate(
  def: AgentDefinition,
  tool: ToolParam,
  autonomy: AutonomyParam
): boolean {
  // Normalize the tool ID and input
  const toolId = typeof tool === "string" ? tool : tool.id;
  const toolInput = typeof tool === "string" ? undefined : tool.input;

  // 1. Deny beats allow: If tool is explicitly denied, always deny!
  const deniedTools = def.deniedTools ?? [];
  if (deniedTools.includes(toolId)) {
    return false;
  }

  // 2. Autonomy Risk: If autonomy is "auto" (or boolean true), hard-limit tools are always denied.
  const isAuto = autonomy === "auto" || autonomy === true;
  if (isAuto && isHardLimitTool(toolId, toolInput)) {
    return false;
  }

  // 3. Allow list: If allowedTools is defined, the tool must be listed in it to be allowed.
  if (def.allowedTools !== undefined) {
    if (!def.allowedTools.includes(toolId)) {
      return false;
    }
  }

  // 4. Role Gate Check: Intersect with role capabilities and permissions.
  const roleGate = def.roleGate ?? def;
  const capabilityMode = roleGate.capabilityMode ?? "all";

  if (capabilityMode === "read-only") {
    // If capability mode is read-only, mutating tools are strictly denied
    if (isMutatingTool(toolId, toolInput)) {
      return false;
    }
  }

  // If the role specifies a restricted tools list, the tool must be in that list (or the floor)
  if (roleGate.tools !== undefined || roleGate.verifiedTools !== undefined) {
    const floor = capabilityMode === "read-only" ? ROLE_READ_ONLY_FLOOR : ROLE_CORE_FLOOR;
    const allowedByRole = [
      ...floor,
      ...(roleGate.tools ?? []),
      ...(roleGate.verifiedTools ?? [])
    ];
    if (!allowedByRole.includes(toolId)) {
      return false;
    }
  }

  return true;
}
