import { z } from "zod";

/** Workflow phases that can each bind their own provider/model pair. */
export const WorkflowModelSlotSchema = z.enum(["normal", "thinking", "compact", "critique", "vlm"]);
export type WorkflowModelSlot = z.infer<typeof WorkflowModelSlotSchema>;

export const WORKFLOW_MODEL_SLOTS = WorkflowModelSlotSchema.options;

/**
 * One bound model for a slot. `provider` is optional so a slot may pin only the
 * model and inherit the ambient provider of the session.
 */
export const ModelBindingSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1)
  })
  .strict();
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

/**
 * Per-slot bindings plus optional explicit fallback chains.
 *
 * Resolution rule (see workflowModelSlots.ts): a phase resolves to its own slot
 * binding when set; otherwise it walks the slot's explicit `fallbacks` chain in
 * order, and finally the default chain ending at `normal`.
 */
export const WorkflowModelSlotsConfigSchema = z
  .object({
    normal: ModelBindingSchema.optional(),
    thinking: ModelBindingSchema.optional(),
    compact: ModelBindingSchema.optional(),
    critique: ModelBindingSchema.optional(),
    vlm: ModelBindingSchema.optional(),
    /** Explicit per-slot fallback chains, e.g. { critique: ["thinking", "normal"] }. */
    fallbacks: z.partialRecord(WorkflowModelSlotSchema, z.array(WorkflowModelSlotSchema).min(1)).default({})
  })
  .strict();
export type WorkflowModelSlotsConfig = z.infer<typeof WorkflowModelSlotsConfigSchema>;
export type WorkflowModelSlotsConfigInput = z.input<typeof WorkflowModelSlotsConfigSchema>;
