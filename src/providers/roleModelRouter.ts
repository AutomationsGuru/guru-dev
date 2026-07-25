import { z } from "zod";

/**
 * Role model router: maps workflow roles to routeId-shaped model ids
 * ("<provider>/<model>") with a minimal fallback contract.
 *
 * Provenance: IDEA-F441 (R-OMP-ROLEMOD), build plan IDEA-F441-ROLEMOD-01.
 * Fallback scope is intentionally minimal: an unknown role resolves to the
 * table's `default` model id. Richer fallback (chains, policy, degradation)
 * is owned by F442 and is deliberately not built here.
 *
 * The module ships schemas plus a pure resolver only — no built-in default
 * table. Role-to-model assignments emerge from operator configuration.
 */
export const ROLE_MODEL_ROLES = ["default", "smol", "slow", "plan", "commit"] as const;
export const RoleModelRoleSchema = z.enum(ROLE_MODEL_ROLES);
export type RoleModelRole = z.infer<typeof RoleModelRoleSchema>;

export const RoleModelTableSchema = z
  .object({
    default: z.string().min(1),
    smol: z.string().min(1),
    slow: z.string().min(1),
    plan: z.string().min(1),
    commit: z.string().min(1)
  })
  .strict();
export type RoleModelTable = z.infer<typeof RoleModelTableSchema>;

export function resolve(role: string, table: RoleModelTable): string {
  const parsedTable = RoleModelTableSchema.safeParse(table);
  if (!parsedTable.success) {
    const paths = formatIssuePaths(parsedTable.error.issues);
    throw new Error(`roleModelRouter: invalid role model table (paths: ${paths})`);
  }

  const parsedRole = RoleModelRoleSchema.safeParse(role);
  if (parsedRole.success) {
    return parsedTable.data[parsedRole.data];
  }

  return parsedTable.data.default;
}

function formatIssuePaths(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((issue) => issue.path.join(".") || "<root>").join(", ");
}
