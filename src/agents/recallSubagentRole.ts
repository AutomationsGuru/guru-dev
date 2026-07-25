import { z } from "zod";

/**
 * Recall subagent role (IDEA-F182-RECALL-ROLE-01 · R-LT-RECALL).
 *
 * Provides a strict tool allowlist for read-only memory/search subagents.
 * Write tools (remember/forget/edit/write/bash/spawn) and shell are denied.
 * Intended for history-analyzer / recall-only scout workers.
 *
 * Composes with RoleCapabilityMode "read-only" and ROLE_READ_ONLY_FLOOR.
 */

const RECALL_ALLOWED_TOOLS = [
  "memory_search",
  "memory_get",
  "memory_status",
  "memory_doctor",
  "read"
] as const;

const RecallAllowedToolSchema = z.enum(RECALL_ALLOWED_TOOLS);

export type RecallAllowedTool = z.infer<typeof RecallAllowedToolSchema>;

/** Returns true iff the tool id is on the recall subagent read-only allowlist. */
export function isAllowed(tool: string): boolean {
  return RecallAllowedToolSchema.safeParse(tool).success;
}

/** The frozen allowlist for this role (export for test/docs). */
export const RECALL_SUBAGENT_TOOL_ALLOWLIST: readonly string[] = RECALL_ALLOWED_TOOLS;
