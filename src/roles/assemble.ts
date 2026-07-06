import { ROLE_CORE_FLOOR, ROLE_READ_ONLY_FLOOR, type RoleProfile } from "./schema.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Suit assembly (Phase D) — pure functions that turn a RoleProfile into the
 * session's model-facing surfaces. Assembly FILTERS what registers/offers;
 * it never edits core and never widens past the gates: write tools stay
 * write-gated by the mandate/approval path regardless of the loadout.
 */

export interface AssembledSuit {
  /** Tool ids offered to the model this session (floor + selected + verified). */
  readonly chatToolIds: ReadonlySet<string>;
  /** Tool ids the suit asked for that are not registered (surface, don't hide). */
  readonly missingTools: readonly string[];
  /** Skill ids to load (subset of the discovered catalog). */
  readonly skillIds: readonly string[];
}

/**
 * Model-capability verification: does the day's connected route satisfy the
 * suit's requirements? Uses the catalog's probe-informed capability flags.
 */
export function verifyModelForRole(
  role: RoleProfile,
  route: ProviderRouteDescriptor | null
): { readonly ok: boolean; readonly unmet: readonly string[] } {
  if (!route) {
    return { ok: false, unmet: [...role.modelPreference.requires] };
  }
  const unmet: string[] = [];
  for (const requirement of role.modelPreference.requires) {
    if (requirement === "chat") {
      continue; // a connected chat route satisfies chat by construction
    }
    if (requirement === "tools" && !route.capabilities.supportsTools) {
      unmet.push("tools");
    }
    if (requirement === "vision" && !route.capabilities.supportsVision) {
      unmet.push("vision");
    }
    if (requirement === "thinking" && !route.capabilities.supportsReasoning) {
      unmet.push("thinking");
    }
  }
  return { ok: unmet.length === 0, unmet };
}

/**
 * Assemble the suit's model-facing tool surface from the registered tools:
 * - read-only suits: the read floor + read-only selections only.
 * - "all" suits: the core floor + the suit's tools + its verified tools.
 * Selection only — a tool must be REGISTERED to be offered, and gates survive.
 */
export function assembleSuit(
  role: RoleProfile,
  registeredToolIds: ReadonlySet<string>,
  readOnlyToolIds: ReadonlySet<string>
): AssembledSuit {
  const floor = role.capabilityMode === "read-only" ? ROLE_READ_ONLY_FLOOR : ROLE_CORE_FLOOR;
  const wanted = [...floor, ...role.tools, ...role.verifiedTools];
  const chatToolIds = new Set<string>();
  const missing: string[] = [];

  for (const toolId of wanted) {
    if (!registeredToolIds.has(toolId)) {
      if (!floor.includes(toolId)) {
        missing.push(toolId);
      }
      continue;
    }
    if (role.capabilityMode === "read-only" && !readOnlyToolIds.has(toolId) && !ROLE_READ_ONLY_FLOOR.includes(toolId)) {
      continue; // a read-only suit physically cannot offer a mutating tool
    }
    chatToolIds.add(toolId);
  }

  return { chatToolIds, missingTools: [...new Set(missing)], skillIds: role.skills };
}
