import type { SurfaceModelRolesConfig, SurfaceRole } from "./surfaceModelRolesSchema.js";

/**
 * Cheap/fast baseline route for the `apply` role (structured edit ops) when
 * neither an explicit apply ref nor a config default is set. Chosen from
 * LITELLM_BASELINE_ALIASES in src/router/schemas.ts.
 */
export const DEFAULT_APPLY_MODEL_REF = "router-foundry-fast";

/**
 * Resolve the model ref for a surface role. Order: explicit per-role ref →
 * config.default → DEFAULT_APPLY_MODEL_REF for the `apply` role. Throws a
 * descriptive error when a non-apply role has neither a per-role ref nor a
 * default configured.
 */
export function resolveSurfaceModelRef(config: SurfaceModelRolesConfig | undefined, role: SurfaceRole): string {
  const perRole = config?.[role];
  if (perRole !== undefined) {
    return perRole;
  }

  if (config?.default !== undefined) {
    return config.default;
  }

  if (role === "apply") {
    return DEFAULT_APPLY_MODEL_REF;
  }

  throw new Error(
    `No model ref configured for surface role "${role}" and no default model ref is configured.`
  );
}
