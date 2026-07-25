import { z } from "zod";

/**
 * Eligibility gate (F26) — which task classes may speculative-scout.
 *
 * The engine is off by default. An allowlist of task shapes/tags is the only
 * way to turn speculation on for a given pending step. The gate returns a
 * reason on deny so the caller can log / observe why lookahead stayed off.
 *
 * No durable PII is captured; decisions are deterministic from config + task.
 */

export const EligibilityAllowlistSchema = z
  .object({
    /** Task class tags whose pending steps may be speculated. */
    tags: z.array(z.string().trim().min(1)).default([]),
    /** Tool IDs that are explicitly eligible for lookahead. */
    toolIds: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

export type EligibilityAllowlist = z.infer<typeof EligibilityAllowlistSchema>;

export interface EligibilityTaskShape {
  readonly toolId: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface EligibilityDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface EligibilityGate {
  /** Decide if a pending task may be speculative-scouted. */
  decide(task: EligibilityTaskShape): EligibilityDecision;
  /** Read back the effective allowlist. */
  allowlist(): Readonly<EligibilityAllowlist>;
}

export function createEligibilityGate(allowlist?: unknown): EligibilityGate {
  const config = EligibilityAllowlistSchema.parse(allowlist ?? {});
  const tagSet = new Set(config.tags);
  const toolSet = new Set(config.toolIds);

  return {
    decide(task: EligibilityTaskShape): EligibilityDecision {
      if (toolSet.has(task.toolId)) {
        return { allowed: true, reason: `toolId "${task.toolId}" in allowlist` };
      }
      for (const tag of task.tags ?? []) {
        if (tagSet.has(tag)) {
          return { allowed: true, reason: `tag "${tag}" in allowlist` };
        }
      }
      return { allowed: false, reason: `task not in lookahead allowlist (toolId "${task.toolId}")` };
    },
    allowlist(): Readonly<EligibilityAllowlist> {
      return config;
    }
  };
}
