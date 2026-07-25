import { z } from "zod";

/**
 * Model tier route hint (IDEA-F601-TIER-01, R-TIER-01): map a task tier
 * light|standard|heavy to a model id from a caller-supplied catalog. Unknown
 * tiers FAIL CLOSED — never coerced, never guessed, never substituted with
 * another tier's model; a rejection names the rejected tier so the caller can
 * surface it honestly.
 *
 * Pure hint resolver: no I/O, no provider/role imports. The F601 packet
 * overlaps existing role/tier routing (src/roles/, src/providers/catalog.ts) —
 * this module deliberately stays uncoupled from those systems; a future
 * integration lane owns any wiring through the extension seam.
 */

/** The closed tier vocabulary. Case-sensitive; anything else is unknown. */
export const TierSchema = z.enum(["light", "standard", "heavy"]);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Caller-supplied tier → model id catalog. Model ids are non-empty trimmed
 * strings; the object is strict so unknown tiers cannot smuggle extra routes.
 * All three tier keys are optional — a partial catalog is representable, and
 * routeTier fails closed on the missing tier rather than guessing.
 */
export const TierRouteCatalogSchema = z
  .object({
    light: z.string().trim().min(1).optional(),
    standard: z.string().trim().min(1).optional(),
    heavy: z.string().trim().min(1).optional()
  })
  .strict();
export type TierRouteCatalog = z.infer<typeof TierRouteCatalogSchema>;

/** Successful route hint: the tier resolved to its catalog model id. */
export interface TierRouteHit {
  readonly ok: true;
  readonly tier: Tier;
  readonly modelId: string;
}

/** Failed route hint: fail-closed rejection; the reason names the tier. */
export interface TierRouteMiss {
  readonly ok: false;
  /** The tier as supplied by the caller (possibly unknown). */
  readonly tier: string;
  readonly reason: string;
}

export type TierRouteResult = TierRouteHit | TierRouteMiss;

/**
 * Resolve a task tier to a model id from the catalog. Pure; the catalog is
 * never mutated.
 *
 * Fail-closed cases (all return `{ ok: false }`, never throw):
 * - tier is not exactly "light" | "standard" | "heavy" (case variants,
 *   near-misses, empty strings are all unknown — no coercion, no fallback);
 * - the tier is known but absent from the catalog;
 * - the catalog maps the tier to an empty/whitespace-only model id
 *   (defensive: such input already fails TierRouteCatalogSchema).
 */
export function routeTier(tier: string, catalog: TierRouteCatalog): TierRouteResult {
  const parsed = TierSchema.safeParse(tier);
  if (!parsed.success) {
    return {
      ok: false,
      tier,
      reason: `Unknown model tier "${tier}" — expected exactly one of: light, standard, heavy. Failing closed (no fallback model).`
    };
  }
  const modelId = catalog[parsed.data];
  if (modelId === undefined || modelId.trim().length === 0) {
    return {
      ok: false,
      tier: parsed.data,
      reason: `Catalog has no usable model id for tier "${parsed.data}". Failing closed (no substitution from another tier).`
    };
  }
  return { ok: true, tier: parsed.data, modelId };
}
