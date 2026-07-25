import { z } from "zod";

/**
 * Design-section sign-off gate.
 *
 * A design record is chunked into sections. Implementation of the corresponding
 * work is blocked until the design is signed off, or until an operator records
 * an explicit override with a reason. This module is pure: it decides whether
 * the implementation path is open given a design and an optional sign-off.
 */

export const DesignSectionSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    status: z.enum(["draft", "review", "approved"])
  })
  .strict();
export type DesignSection = z.infer<typeof DesignSectionSchema>;

export const DesignDocSchema = z
  .object({
    id: z.string().trim().min(1),
    sections: z.array(DesignSectionSchema)
  })
  .strict();
export type DesignDoc = z.infer<typeof DesignDocSchema>;

export const SignOffOverrideSchema = z
  .object({
    reason: z.string().trim().min(1)
  })
  .strict();
export type SignOffOverride = z.infer<typeof SignOffOverrideSchema>;

export const SignOffSchema = z
  .object({
    approvedAt: z.string().datetime(),
    override: SignOffOverrideSchema.optional()
  })
  .strict();
export type SignOff = z.infer<typeof SignOffSchema>;

/**
 * Returns true only when the design may proceed to implementation:
 * a present, well-formed sign-off, with any override carrying a reason.
 * Returns false when the sign-off is absent or malformed — implementation
 * stays blocked in that case rather than silently opening.
 */
export function canImplement(design: DesignDoc, signOff: SignOff | null | undefined): boolean {
  if (signOff == null) {
    return false;
  }
  const parsed = SignOffSchema.safeParse(signOff);
  if (!parsed.success) {
    return false;
  }
  if (parsed.data.override && parsed.data.override.reason.trim().length === 0) {
    return false;
  }
  void design;
  return true;
}
