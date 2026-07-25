import { z } from "zod";

/**
 * Role Runtime Map (IDEA-F450-ROLERT-01)
 *
 * Maps a role id (slug) to its runtime surface: 'cli' or 'api'.
 * Unknown roles fail closed (throw) — explicit registration required.
 * This keeps the decision table small, owned, and auditable.
 * Future roles register here or via governed extension seam.
 */

export const RuntimeIdSchema = z.enum(["cli", "api"]);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

/** Known role → runtime assignments. Start minimal; grow only with evidence. */
const ROLE_RUNTIME_MAP: Record<string, RuntimeId> = {
  // Core coordination and build roles run CLI (interactive / YOLO surfaces)
  coordinator: "cli",
  builder: "cli",
  "ship/code-review": "cli",

  // Example API-only roles (reserved for future surfaces)
  // "web-gateway": "api",
};

/**
 * Resolve the runtime for a role id.
 * Throws on unknown role — fails closed, no silent default.
 */
export function resolveRoleRuntime(roleId: string): RuntimeId {
  const runtime = ROLE_RUNTIME_MAP[roleId];
  if (runtime === undefined) {
    throw new Error(
      `Unknown role "${roleId}": fails closed. Add to roleRuntimeMap or use a registered role id.`
    );
  }
  return runtime;
}
