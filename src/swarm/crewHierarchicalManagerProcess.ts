import { z } from "zod";

/**
 * Crew process mode — sequential delegates tasks in order; hierarchical
 * delegates through a manager agent that owns task assignment.
 *
 * Requirement R-CR-HIER: process=hierarchical requires managerId;
 * sequential does not.
 */
export const CrewProcessSchema = z.enum(["sequential", "hierarchical"]);

export type CrewProcess = z.infer<typeof CrewProcessSchema>;

/**
 * Crew process options discriminated on `process`.
 *
 * - sequential: managerId is optional (not used).
 * - hierarchical: managerId is required — the manager agent that owns
 *   delegation. Without it the crew has no delegation authority and the
 *   configuration is invalid.
 */
export const CrewProcessOptionsSchema = z.discriminatedUnion("process", [
  z
    .object({
      process: z.literal(CrewProcessSchema.enum.sequential),
      /** Optional in sequential — the crew runs as a flat ordered pipeline. */
      managerId: z.string().trim().min(1).optional()
    })
    .strict(),
  z
    .object({
      process: z.literal(CrewProcessSchema.enum.hierarchical),
      /** Required in hierarchical — the manager agent that owns delegation. */
      managerId: z.string().trim().min(1)
    })
    .strict()
]);

export type CrewProcessOptions = z.infer<typeof CrewProcessOptionsSchema>;

/**
 * Validate crew process options.
 *
 * When `process` is `"hierarchical"`, `managerId` must be a non-empty
 * string. When `process` is `"sequential"`, `managerId` is optional.
 *
 * Throws ZodError on schema violations (invalid process, missing
 * required managerId, or extra keys).
 */
export function validateProcess(opts: unknown): CrewProcessOptions {
  return CrewProcessOptionsSchema.parse(opts);
}
