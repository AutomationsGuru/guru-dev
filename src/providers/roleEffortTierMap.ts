import { z } from "zod";

/**
 * Effort tiers 0-4 — model-agnostic effort steering for an agent role.
 * Kept as a thin owned primitive: no provider/model brand lock-in.
 */
export const EffortTierSchema = z.number().int().min(0).max(4);
export type EffortTier = z.infer<typeof EffortTierSchema>;

/**
 * Role -> effort tier map (K7 / F366 residual). A role resolves to a tier by:
 *   1. direct entry in `tiers`, else
 *   2. following an explicit `inherit` parent (cycle-safe), else
 *   3. `default` (mid = 2), which is also the unknown-role fallback.
 */
export const RoleEffortTierMapSchema = z
  .object({
    default: EffortTierSchema.default(2),
    tiers: z.record(z.string().min(1), EffortTierSchema).default({}),
    inherit: z.record(z.string().min(1), z.string().min(1)).default({})
  })
  .strict();

export type RoleEffortTierMap = z.infer<typeof RoleEffortTierMapSchema>;
export type RoleEffortTierMapInput = z.input<typeof RoleEffortTierMapSchema>;

export function defineRoleEffortTierMap(input: RoleEffortTierMapInput): RoleEffortTierMap {
  return RoleEffortTierMapSchema.parse(input);
}

export function resolveTier(role: string, map: RoleEffortTierMap): EffortTier {
  const normalized = role.trim().toLowerCase();
  const visited = new Set<string>();
  return walkInheritance(normalized, map, visited);
}

function walkInheritance(role: string, map: RoleEffortTierMap, visited: Set<string>): EffortTier {
  if (visited.has(role)) {
    return map.default;
  }
  visited.add(role);

  const direct = map.tiers[role];
  if (direct !== undefined) {
    return EffortTierSchema.parse(direct);
  }

  const parent = map.inherit[role];
  if (parent !== undefined) {
    return walkInheritance(parent.trim().toLowerCase(), map, visited);
  }

  return map.default;
}
