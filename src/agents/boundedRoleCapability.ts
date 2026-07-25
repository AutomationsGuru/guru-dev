import {
  ROLE_CORE_FLOOR,
  ROLE_READ_ONLY_FLOOR,
  type RoleProfile
} from "../roles/schema.js";

/**
 * Bounded role capability (IDEA-F396-ROLECAP) — a runtime tool gate that turns
 * a role's allowed-tools set into a deny-by-default decision.
 *
 * `assembleSuit` (src/roles/assemble.ts) SELECTS which tools are *offered* to
 * the model from the registered catalog. This module is the complementary
 * capability BOUND: given a role and a tool id, `mayUseTool` answers whether
 * that tool is inside the role's allowed set. A tool outside the set is denied.
 *
 * The bound is structural, never advisory:
 *  - the allowed set is the role's capability floor ∪ its selected tools ∪ its
 *    verified tools;
 *  - a `read-only` role's floor is the read floor, and mutating tools (edit /
 *    write / bash) are denied even when a loadout lists them — selection never
 *    widens past a hard edge. Write tools additionally stay gated by the
 *    mandate/approval path regardless of this decision.
 *
 * This module never edits core and never weakens a hard limit; it is selection
 * only. It composes with the roles layer rather than duplicating it.
 */

/**
 * The frozen allowed-tools set for a role. A tool is permitted iff it is a
 * member of this set. The set is derived purely from the RoleProfile.
 */
export function roleAllowedTools(role: RoleProfile): ReadonlySet<string> {
  const floor =
    role.capabilityMode === "read-only" ? ROLE_READ_ONLY_FLOOR : ROLE_CORE_FLOOR;
  const allowed = new Set<string>(floor);

  for (const tool of role.tools) {
    // read-only roles can never gain mutating tools via their loadout — the
    // floor is the ceiling for write-class tools in that mode.
    if (role.capabilityMode === "read-only" && isMutatingTool(tool)) {
      continue;
    }
    allowed.add(tool);
  }

  for (const tool of role.verifiedTools) {
    if (role.capabilityMode === "read-only" && isMutatingTool(tool)) {
      continue;
    }
    allowed.add(tool);
  }

  return allowed;
}

/**
 * Capability decision: may this role use this tool? `true` only when the tool
 * is inside the role's allowed set; `false` for any tool outside the set.
 */
export function mayUseTool(role: RoleProfile, tool: string): boolean {
  return roleAllowedTools(role).has(tool);
}

/**
 * Tools a read-only role is structurally barred from, regardless of loadout.
 * Kept narrow and explicit so the bound is legible and auditable. The core
 * floor minus the read floor defines the mutating class.
 */
const READ_ONLY_DENIED: readonly string[] = ROLE_CORE_FLOOR.filter(
  (tool) => !ROLE_READ_ONLY_FLOOR.includes(tool)
);

function isMutatingTool(tool: string): boolean {
  return READ_ONLY_DENIED.includes(tool);
}
