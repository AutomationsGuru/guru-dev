import { z } from "zod";

/**
 * Parity-gap registry schemas.
 *
 * Every ATTACH integration must register what it borrows, why it is not native,
 * what would trigger promotion to native, and its current operator-visible status.
 * The registry is honest by default: an unregistered gap is a dependency-drift
 * smell that the product vision forbids.
 */

/** Lower-case slug stable id for the attached capability. */
export const ParityGapIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z][a-z0-9._-]{0,63}$/u, "Expected a lowercase slug (a-z, 0-9, dot, dash, underscore; max 64 chars).");
export type ParityGapId = z.infer<typeof ParityGapIdSchema>;

/** Operator-visible lifecycle of a parity gap. */
export const ParityGapStatusSchema = z.enum(["open", "in-progress", "promoted", "wont-fix", "stale"]);
export type ParityGapStatus = z.infer<typeof ParityGapStatusSchema>;

export const ParityGapEntrySchema = z
  .object({
    id: ParityGapIdSchema,
    surface: z.string().trim().min(1),
    gapDescription: z.string().trim().min(1, "Gap description must be non-empty."),
    promotionTrigger: z.string().trim().min(1, "Promotion trigger must be non-empty."),
    status: ParityGapStatusSchema.default("open"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** True when the entry has been passed through the secret scrubber before persistence. */
    secretScrubbed: z.boolean().default(false)
  })
  .strict();
export type ParityGapEntry = z.infer<typeof ParityGapEntrySchema>;

export const ParityGapRegisterInputSchema = ParityGapEntrySchema.omit({
  createdAt: true,
  updatedAt: true,
  secretScrubbed: true
});
export type ParityGapRegisterInput = z.infer<typeof ParityGapRegisterInputSchema>;

export const ParityGapListResultSchema = z
  .object({
    entries: z.array(ParityGapEntrySchema),
    count: z.number().int().nonnegative()
  })
  .strict();
export type ParityGapListResult = z.infer<typeof ParityGapListResultSchema>;
