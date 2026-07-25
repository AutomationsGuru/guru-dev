import {
  BOUNDED_ROLE_TOOL_WILDCARD,
  getBoundedRoleDefinition,
  type BoundedRole
} from "./boundedRoleAgents.js";

/**
 * Bounded role tool gate (IDEA-F113-BOUNDED-ROLES-01, 2026-07-19).
 *
 * A PURE policy function: given a role and a tool request, decide allow or
 * deny without I/O, without consulting model output, and without hidden
 * state. The model proposes; the gate disposes. Enforcement here is
 * structural (prompt-rule drift guard): a denied tool never reaches the
 * registry because the caller evaluates `assertToolAllowed` first.
 */

export type ToolGateDecision = "ok" | "deny";

export interface ToolGateResult {
  readonly decision: ToolGateDecision;
  readonly role: BoundedRole;
  readonly toolName: string;
  /** Human-legible reason, set on deny (and on ok-with-path-rule for audit). */
  readonly reason?: string;
}

export interface ToolRequest {
  readonly toolName: string;
  /**
   * Target path for write-capable tools (write/edit). Required to evaluate
   * the plan role's path rule; non-write tools may omit it.
   */
  readonly targetPath?: string;
}

/**
 * Path prefixes the `plan` role may write to. Plan artifacts live under a
 * `plans/` directory (any depth) or a top-level `PLAN*.md` file — nothing
 * else. Matching is on normalized, POSIX-style relative paths.
 */
const PLAN_WRITE_PREFIXES: readonly string[] = ["plans/", "planning/"];
const PLAN_WRITE_BASENAME_PATTERN = /^PLAN[^/]*\.md$/u;

function normalizePath(targetPath: string): string {
  return targetPath.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function isPlanWritePath(targetPath: string): boolean {
  const normalized = normalizePath(targetPath);
  if (PLAN_WRITE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? "";
  // A PLAN*.md at any depth is a plan artifact (e.g. docs/PLAN-roles.md).
  return PLAN_WRITE_BASENAME_PATTERN.test(basename);
}

function deny(role: BoundedRole, toolName: string, reason: string): ToolGateResult {
  return { decision: "deny", role, toolName, reason };
}

function ok(role: BoundedRole, toolName: string, reason?: string): ToolGateResult {
  return reason === undefined
    ? { decision: "ok", role, toolName }
    : { decision: "ok", role, toolName, reason };
}

function isAllowlisted(role: BoundedRole, toolName: string): boolean {
  const { toolAllowlist } = getBoundedRoleDefinition(role);
  return toolAllowlist.includes(BOUNDED_ROLE_TOOL_WILDCARD) || toolAllowlist.includes(toolName);
}

/**
 * Decide whether `role` may execute `request.toolName`.
 *
 * Rules:
 * - `implement`: everything allowed (wildcard allowlist).
 * - `research`: allowlist is read-only by construction, so any write or
 *   shell-risk tool (write, edit, bash, shell.command.run, fs.edit.apply, …)
 *   is denied regardless of how the model phrased the request.
 * - `plan`: read tools allowed; write/edit allowed ONLY when `targetPath`
 *   resolves to a plan-artifact path (`plans/**`, `planning/**`, or
 *   `PLAN*.md`). A write without a target path is denied fail-closed.
 */
export function assertToolAllowed(role: BoundedRole, request: ToolRequest): ToolGateResult {
  const { toolName } = request;

  if (!isAllowlisted(role, toolName)) {
    return deny(role, toolName, `tool "${toolName}" is outside the ${role} role's tool boundary`);
  }

  if (role !== "plan") {
    return ok(role, toolName);
  }

  // plan role: write-capable tools carry an additional path rule.
  const isWriteTool = getBoundedRoleDefinition("plan").toolAllowlist.includes(toolName) &&
    !getBoundedRoleDefinition("research").toolAllowlist.includes(toolName);
  if (!isWriteTool) {
    return ok(role, toolName);
  }

  if (request.targetPath === undefined || request.targetPath.trim() === "") {
    return deny(role, toolName, `plan role requires a target path for "${toolName}" (fail-closed)`);
  }
  if (!isPlanWritePath(request.targetPath)) {
    return deny(
      role,
      toolName,
      `plan role may write only plan artifacts (plans/**, planning/**, PLAN*.md); got "${request.targetPath}"`
    );
  }
  return ok(role, toolName, `plan-artifact write permitted: ${normalizePath(request.targetPath)}`);
}
