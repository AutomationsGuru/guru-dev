import { z } from "zod";

/**
 * Tool-level approval declaration (IDEA-F242-TOOL-APPROVE-MODE).
 * Each tool declares its preferred approval posture:
 * - "always_require": never auto-approve this tool
 * - "never_require": safe for auto-allow when not hard-limited
 * - "ask" (default): interactive prompt on use
 *
 * Hard-limit tools (destructive/spend/secret/auth-edge) force require
 * regardless of declaration — the constitution wins.
 */

export const ToolApprovalModeSchema = z.enum(["always_require", "never_require", "ask"]);
export type ToolApprovalMode = z.infer<typeof ToolApprovalModeSchema>;

export interface ToolApprovalResolution {
  readonly requiresApproval: boolean;
  readonly effective: "require" | "auto_allow";
  readonly reason: string;
}

/**
 * resolveApproval(tool, declaredMode, isHardLimit)
 * Returns whether a per-call approval prompt is required for this tool invocation.
 */
export function resolveApproval(
  tool: string,
  declaredMode: ToolApprovalMode = "ask",
  isHardLimit: boolean = false
): ToolApprovalResolution {
  if (isHardLimit) {
    return {
      requiresApproval: true,
      effective: "require",
      reason: `Hard-limit tool "${tool}" — approval always required (constitution §3 hard edges).`
    };
  }

  switch (declaredMode) {
    case "always_require":
      return {
        requiresApproval: true,
        effective: "require",
        reason: `Tool "${tool}" declared always_require.`
      };
    case "never_require":
      return {
        requiresApproval: false,
        effective: "auto_allow",
        reason: `Tool "${tool}" declared never_require — auto-allowed for non-hard-limit use.`
      };
    case "ask":
    default:
      return {
        requiresApproval: true,
        effective: "require",
        reason: `Tool "${tool}" defaults to ask — requires approval.`
      };
  }
}
