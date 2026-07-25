import { z } from "zod";

/**
 * Bounded role agents (IDEA-F113-BOUNDED-ROLES-01, 2026-07-19).
 *
 * Three built-in roles with hard tool boundaries:
 * - `implement` — full tool set (wildcard).
 * - `research`  — read-only tool set; write/shell-risk tools denied.
 * - `plan`      — plan-artifact write + read; no arbitrary code edits.
 *
 * The boundary is enforced in `boundedRoleToolGate.ts` as a PURE policy
 * function evaluated regardless of model output — the model may *request*
 * any tool, but the gate decides. These roles are built-in AGENT MODES
 * (bounded tool surfaces), distinct from the emergent loadout roles in
 * `src/roles/` (which ship empty by design: roles emerge from work).
 */

export const BoundedRoleSchema = z.enum(["implement", "research", "plan"]);

export type BoundedRole = z.infer<typeof BoundedRoleSchema>;

export const BOUNDED_ROLES: readonly BoundedRole[] = BoundedRoleSchema.options;

/**
 * Tool ids are the registry ids from `src/tools/builtins/` (e.g. `read`,
 * `write`, `edit`, `bash`, `glob`, `grep`, `ls`, `web_fetch`, `web_search`).
 * The wildcard `"*"` means the role may request any registered tool.
 */
export const BOUNDED_ROLE_TOOL_WILDCARD = "*" as const;

/**
 * Read-only tool ids shared by `research` (whole set) and `plan` (read side).
 * Anything not listed here is a write or shell-risk tool for gating purposes.
 */
export const READ_ONLY_TOOL_IDS: readonly string[] = [
  "read",
  "glob",
  "grep",
  "ls",
  "web_fetch",
  "web_search",
  "read_diagnostics",
  "repo.context.resolve",
  "todo_list"
];

/**
 * Tools the `plan` role may use to write plan artifacts. The write itself is
 * additionally path-gated in `boundedRoleToolGate.ts` (plan paths only).
 */
export const PLAN_WRITE_TOOL_IDS: readonly string[] = ["write", "edit"];

export interface BoundedRoleDefinition {
  readonly role: BoundedRole;
  readonly summary: string;
  /**
   * Tool ids the role may request. `"*"` (implement) is unrestricted.
   * Membership here is necessary but not sufficient — the tool gate applies
   * role-specific path rules on top (plan writes only under plan paths).
   */
  readonly toolAllowlist: readonly string[];
}

/**
 * Default tool allowlists per bounded role. Frozen so no caller can widen a
 * role's boundary by mutating the shared definition.
 */
export const BOUNDED_ROLE_DEFINITIONS: Readonly<Record<BoundedRole, BoundedRoleDefinition>> = Object.freeze({
  implement: Object.freeze({
    role: "implement",
    summary: "Full tool set — read, write, edit, shell. The default working role.",
    toolAllowlist: Object.freeze([BOUNDED_ROLE_TOOL_WILDCARD])
  }),
  research: Object.freeze({
    role: "research",
    summary: "Read-only tool set — investigate and report. Write and shell-risk tools denied.",
    toolAllowlist: Object.freeze([...READ_ONLY_TOOL_IDS])
  }),
  plan: Object.freeze({
    role: "plan",
    summary: "Plan-artifact write + read — produce plans/* documents. No arbitrary code edits.",
    toolAllowlist: Object.freeze([...READ_ONLY_TOOL_IDS, ...PLAN_WRITE_TOOL_IDS])
  })
});

export function getBoundedRoleDefinition(role: BoundedRole): BoundedRoleDefinition {
  return BOUNDED_ROLE_DEFINITIONS[role];
}
