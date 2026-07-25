import { z } from "zod";

/**
 * TeamBrief — the coordinator's task brief artifact for a specialist worker.
 * Goal, owned paths, tools allowlist, and success checks. Spawn consumes the brief.
 */

export const TeamBriefSchema = z.object({
  /** Non-empty goal: what the specialist must accomplish. */
  goal: z.string().trim().min(1).max(2000),
  /** File paths the specialist owns (absolute or workspace-relative). Empty = read-only scout. */
  ownedPaths: z.array(z.string().trim()).default([]),
  /** Tool IDs the specialist is allowed to call. Empty = no tool access. */
  toolAllowlist: z.array(z.string().trim()).default([]),
  /** Verification checks the specialist must satisfy before returning. */
  successChecks: z.array(z.string().trim()).default([]),
});

export type TeamBrief = z.infer<typeof TeamBriefSchema>;

/** Validated clamp: dedupe and sort the allowlist, strip blanks. */
export function clampAllowlist(raw: string[]): string[] {
  return [...new Set(raw.map(s => s.trim()).filter(Boolean))].sort();
}