import { z } from "zod";

/**
 * Model role pack schema (IDEA-F3, R-PD-PACK / R-PD-PACK-SW, 2026-07-18).
 *
 * A model role pack is DATA: a named map from harness roles to provider/model
 * ids, with optional per-role large-context and strong-model fallbacks. Packs
 * are config-driven and model-agnostic — a `model` value is an opaque
 * provider/model id resolved by the caller's own routing layer, never a
 * provider install, marketplace entry, or framework reference. This module
 * ships no provider knowledge and adds no runtime dependency.
 *
 * Roles are the fixed harness seams a pack may specialize. A pack may define
 * any subset; absent roles resolve to the session default model (see
 * `modelRolePack.ts`). The built-in `daily-driver` pack maps every role to the
 * session default, so enabling pack resolution with no config override is an
 * identity (no behavior change).
 */

export const MODEL_ROLE_PACK_ROLES = [
  "planner",
  "architect",
  "coder",
  "builder",
  "wholeFileBuilder",
  "summarizer",
  "critic",
  "adversary",
  "autoContinue",
  "commitMessages"
] as const;

export const ModelRoleSchema = z.enum(MODEL_ROLE_PACK_ROLES);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

/**
 * One role binding. `model` is the primary provider/model id.
 * `largeContextFallback` is used when the caller reports the working context
 * exceeds its budget; `strongModel` is an optional always-stronger id reserved
 * for escalation. Both are bounded single-step fallbacks — there is no chain.
 */
export const RoleModelBindingSchema = z
  .object({
    model: z.string().trim().min(1),
    largeContextFallback: z.string().trim().min(1).optional(),
    strongModel: z.string().trim().min(1).optional()
  })
  .strict();
export type RoleModelBinding = z.infer<typeof RoleModelBindingSchema>;

/** Pack id: a config-key-safe slug. */
export const ModelRolePackIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u);

/**
 * A named role→model map. `roles` keys are restricted to the known harness
 * seams so an unknown role name in config fails at parse time rather than
 * silently never resolving.
 */
export const ModelRolePackSchema = z
  .object({
    id: ModelRolePackIdSchema,
    roles: z.partialRecord(ModelRoleSchema, RoleModelBindingSchema).default({})
  })
  .strict();
export type ModelRolePack = z.infer<typeof ModelRolePackSchema>;
export type ModelRolePackInput = z.input<typeof ModelRolePackSchema>;

/**
 * The operator-facing pack config: an optional registry of named packs plus
 * the id of the active one. `activePack` is optional; when absent (or naming
 * an id not present in `packs`) resolution falls back to the built-in
 * `daily-driver` identity pack, preserving current single-model behavior.
 */
export const ModelRolePackConfigSchema = z
  .object({
    packs: z.array(ModelRolePackSchema).default([]),
    activePack: ModelRolePackIdSchema.optional()
  })
  .strict();
export type ModelRolePackConfig = z.infer<typeof ModelRolePackConfigSchema>;
export type ModelRolePackConfigInput = z.input<typeof ModelRolePackConfigSchema>;
