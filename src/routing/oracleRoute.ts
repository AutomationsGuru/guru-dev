import { z } from "zod";

/**
 * Oracle second-opinion route resolution (F86). The oracle consults a DISTINCT
 * high-reasoning route on a question/diff and returns analysis only — consult
 * is not a review gate and never blocks. When an F3 model role pack is present
 * the pack's `oracle` (then `critic`) role wins; otherwise an explicit config
 * route is used. With nothing configured the resolver fails CLOSED: no silent
 * fallback onto the author route, because a second opinion from the same model
 * is not a second opinion.
 */

/** Minimal F3 model-role-pack shape this module consumes (forward-compatible seam). */
export const OracleRolePackRoleSchema = z
  .object({
    model: z.string().trim().min(1)
  })
  .strict();
export type OracleRolePackRole = z.infer<typeof OracleRolePackRoleSchema>;

export const OracleRolePackSchema = z
  .object({
    id: z.string().trim().min(1),
    roles: z.record(z.string(), OracleRolePackRoleSchema)
  })
  .strict();
export type OracleRolePack = z.infer<typeof OracleRolePackSchema>;

export const OracleRouteConfigSchema = z
  .object({
    /** Explicit oracle model id/alias (used when no role pack supplies a route). */
    model: z.string().trim().min(1).optional(),
    /**
     * When true (default), a route identical to the author model is rejected.
     * Set false only to deliberately re-ask the same model (weaker, but explicit).
     */
    requireDistinctFromAuthor: z.boolean().default(true)
  })
  .strict();
export type OracleRouteConfig = z.infer<typeof OracleRouteConfigSchema>;

export type OracleRouteSource = "role-pack" | "config";

export interface OracleRoute {
  readonly model: string;
  readonly source: OracleRouteSource;
  /** True when the oracle model differs from the author model. */
  readonly distinctFromAuthor: boolean;
}

export type OracleRouteStatus = "resolved" | "missing" | "not-distinct";

export interface OracleRouteResolution {
  readonly status: OracleRouteStatus;
  readonly route?: OracleRoute;
  readonly reason: string;
}

export interface ResolveOracleRouteOptions {
  readonly config: OracleRouteConfig;
  /** The model that produced the work under question (the "author"). */
  readonly authorModel?: string;
  /** F3 model role pack, when that feature is present. */
  readonly rolePack?: OracleRolePack;
}

/**
 * Resolve which model the oracle should consult. Preference order:
 * role-pack `oracle` role → role-pack `critic` role → explicit config model → fail closed.
 */
export function resolveOracleRoute(options: ResolveOracleRouteOptions): OracleRouteResolution {
  const config = OracleRouteConfigSchema.parse(options.config);
  const author = options.authorModel?.trim();

  const packRole = options.rolePack?.roles["oracle"] ?? options.rolePack?.roles["critic"];
  const candidate: { readonly model: string; readonly source: OracleRouteSource } | undefined = packRole
    ? { model: packRole.model, source: "role-pack" }
    : config.model
      ? { model: config.model, source: "config" }
      : undefined;

  if (!candidate) {
    return {
      status: "missing",
      reason:
        "No oracle route configured (no role-pack oracle/critic role and no oracle model in config) — failing closed rather than echoing the author model."
    };
  }

  const distinct = author === undefined || author.length === 0 ? true : candidate.model !== author;
  if (!distinct && config.requireDistinctFromAuthor) {
    return {
      status: "not-distinct",
      reason: `Oracle route "${candidate.model}" is identical to the author model and requireDistinctFromAuthor is on — a second opinion must come from a distinct route.`
    };
  }

  return {
    status: "resolved",
    route: { model: candidate.model, source: candidate.source, distinctFromAuthor: distinct },
    reason:
      candidate.source === "role-pack"
        ? `Oracle route resolved from role pack role "${packRole === options.rolePack?.roles["oracle"] ? "oracle" : "critic"}".`
        : "Oracle route resolved from explicit config."
  };
}
