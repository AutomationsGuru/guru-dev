import { z } from "zod";

export const SurfaceRoleSchema = z.enum(["chat", "edit", "apply", "agent"]);

export type SurfaceRole = z.infer<typeof SurfaceRoleSchema>;

/** A model ref is a model-agnostic router alias name — no URLs, keys, or secrets. */
export const ModelRefSchema = z.string().trim().min(1);

export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Maps surface roles to model refs; `default` covers any role left unset. */
export const SurfaceModelRolesConfigSchema = z
  .object({
    chat: ModelRefSchema.optional(),
    edit: ModelRefSchema.optional(),
    apply: ModelRefSchema.optional(),
    agent: ModelRefSchema.optional(),
    default: ModelRefSchema.optional()
  })
  .strict();

export type SurfaceModelRolesConfig = z.infer<typeof SurfaceModelRolesConfigSchema>;
