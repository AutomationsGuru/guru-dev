import { z } from "zod";

/**
 * IDEA-B5 critic-route selection (R-AS-REVIEW): review/critic passes can require a
 * DIFFERENT model route than the author. This module is the pure resolver — it owns
 * the config shape, the sameness check, and the fail-closed decision; it never
 * touches the network, a provider client, or the swarm manager. Wiring (spawn tool
 * calling this for role=review|verifier) lives in the swarm/spawn lane; this module
 * is the structural gate that lane must call.
 *
 * Fail-closed contract (enforced here, never prompt-only):
 *  - A critic-role spawn with no critic route configured is REFUSED
 *    (critic_route_missing) — review silently reusing the author's route is the
 *    failure mode this gate exists to prevent.
 *  - policy "require_distinct" refuses a critic route provably identical to the
 *    author's (critic_route_same_as_author) and flags the result for operator
 *    escalation — an independent reviewer cannot be the same mind.
 *  - policy "prefer_distinct" accepts a same-route config but returns a warning so
 *    the caller can surface the weakened independence honestly.
 */

/** Roles whose spawns must route through the critic gate. */
export const CRITIC_ROLES = ["review", "verifier"] as const;
export type CriticRole = (typeof CRITIC_ROLES)[number];

export function isCriticRole(role: string): role is CriticRole {
  return (CRITIC_ROLES as readonly string[]).includes(role);
}

/**
 * A route reference. `routeId` names a configured route (e.g. a router alias or
 * session route id); the provider/model pair addresses a model directly. At least
 * one form is required; both may be present (routeId as canonical identity,
 * provider/model as descriptive detail).
 */
export const RouteRefSchema = z
  .object({
    routeId: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional()
  })
  .strict()
  .refine((ref) => ref.routeId !== undefined || (ref.provider !== undefined && ref.model !== undefined), {
    message: "A route ref needs a routeId or a provider/model pair."
  });
export type RouteRef = z.infer<typeof RouteRefSchema>;

export const CriticRoutePolicySchema = z.enum(["prefer_distinct", "require_distinct"]);
export type CriticRoutePolicy = z.infer<typeof CriticRoutePolicySchema>;

export const CriticRouteConfigSchema = z
  .object({
    /** The configured critic route — absent means "no critic route configured". */
    route: RouteRefSchema.optional(),
    policy: CriticRoutePolicySchema.default("prefer_distinct")
  })
  .strict();
export type CriticRouteConfig = z.infer<typeof CriticRouteConfigSchema>;

export const CriticRouteFailureCodeSchema = z.enum(["critic_route_missing", "critic_route_same_as_author", "critic_route_invalid"]);
export type CriticRouteFailureCode = z.infer<typeof CriticRouteFailureCodeSchema>;

export interface CriticRouteDecisionAllow {
  readonly ok: true;
  readonly route: RouteRef;
  /** Non-fatal notes (e.g. same route accepted under prefer_distinct). */
  readonly warnings: readonly string[];
}

export interface CriticRouteDecisionDeny {
  readonly ok: false;
  readonly code: CriticRouteFailureCode;
  readonly message: string;
  /**
   * Risk escalates to the operator: the caller must stop and ask rather than
   * silently fall back to the author's route. Always true on a deny — a refused
   * critic gate is exactly the decision the operator owns.
   */
  readonly escalateToOperator: true;
}

export type CriticRouteDecision = CriticRouteDecisionAllow | CriticRouteDecisionDeny;

/**
 * Provable sameness. Two refs are the same route when any comparable identity
 * dimension matches exactly: equal routeIds, or equal provider AND model. Mixed
 * forms (one side routeId-only, the other provider/model-only) cannot be proven
 * same OR distinct — treated as not provably same here; the require_distinct
 * caller that needs certainty should configure comparable forms.
 */
export function isSameRoute(critic: RouteRef, author: RouteRef): boolean {
  if (critic.routeId !== undefined && author.routeId !== undefined && critic.routeId === author.routeId) {
    return true;
  }
  if (
    critic.provider !== undefined &&
    critic.model !== undefined &&
    author.provider !== undefined &&
    author.model !== undefined &&
    critic.provider === author.provider &&
    critic.model === author.model
  ) {
    return true;
  }
  return false;
}

export interface ResolveCriticRouteInput {
  /** Raw critic-route config (parsed through CriticRouteConfigSchema). */
  readonly config: z.input<typeof CriticRouteConfigSchema>;
  /** The author's current route — the identity the critic must differ from. */
  readonly authorRoute: RouteRef;
}

/**
 * Resolve the route a critic-role spawn must use. Pure and total: every config /
 * author combination returns a decision; invalid config shapes deny rather than
 * throw so a malformed config can never crash the gate open.
 */
export function resolveCriticRoute(input: ResolveCriticRouteInput): CriticRouteDecision {
  const parsed = CriticRouteConfigSchema.safeParse(input.config);
  if (!parsed.success) {
    return {
      ok: false,
      code: "critic_route_invalid",
      message: `Critic route config is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      escalateToOperator: true
    };
  }

  const config = parsed.data;
  if (config.route === undefined) {
    return {
      ok: false,
      code: "critic_route_missing",
      message: "A critic-role spawn requires a configured critic route, and none is set. Refusing to silently reuse the author's route.",
      escalateToOperator: true
    };
  }

  if (isSameRoute(config.route, input.authorRoute)) {
    if (config.policy === "require_distinct") {
      return {
        ok: false,
        code: "critic_route_same_as_author",
        message: "Critic route is identical to the author's route and policy=require_distinct. An independent review cannot come from the same route.",
        escalateToOperator: true
      };
    }
    return {
      ok: true,
      route: config.route,
      warnings: ["Critic route equals the author's route; review independence is weakened (policy=prefer_distinct)."]
    };
  }

  return { ok: true, route: config.route, warnings: [] };
}
