/**
 * Worker model override (F276) — resolves which model id a subagent/worker runs
 * under. A worker definition may set a model id override distinct from the
 * parent session's route; when set to a non-empty trimmed string the worker runs
 * on the override, otherwise it inherits the parent route's model. Pure and
 * side-effect free.
 *
 * This is the route-level complement to the swarm-level helper
 * `src/swarm/subagentModelOverride.ts` (F216): that one takes the parent model
 * id plus a def carrying `modelId`; this one takes the parent route's model id
 * plus an override that may arrive as a bare string or as a def carrying
 * `modelOverride`.
 */

/** Parameter shape for {@link resolveWorkerModel}; allows `modelOverride` to be absent. */
export type WorkerModelOverride = { readonly modelOverride?: string };

/** A worker/subagent definition. The optional `modelOverride` overrides the parent route's model. */
export interface WorkerDef extends WorkerModelOverride {}

/** Model id override as supplied by a worker def: a bare string or an object carrying `modelOverride`. */
export type WorkerModelOverrideInput = string | WorkerModelOverride | undefined;

/**
 * Resolve the effective model id for a worker.
 *
 * If the override is a non-empty trimmed string, that override wins; otherwise
 * the worker inherits `parentRoute` (the parent session route's model id).
 * Whitespace-only values are treated as absent so a stray blank never silently
 * clears the parent route's model.
 */
export function resolveWorkerModel(parentRoute: string, override: WorkerModelOverrideInput): string {
  const raw = typeof override === "string" ? override : override?.modelOverride;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : parentRoute;
}
