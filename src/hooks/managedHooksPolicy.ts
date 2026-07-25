/**
 * Minimal hook invocation shape (matches shellHooks internal).
 * Kept local so this policy module has no dependency on internal types.
 */
interface HookInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Hook layer descriptor for resolve order.
 * "managed" = home ~/.guruharness/hooks (dogfood admin controlled)
 * "user" or project-local = .guru/hooks (wins by default)
 */
export interface HookLayer {
  readonly name: string;
  readonly invocations: readonly HookInvocation[];
}

/**
 * Resolve hook invocations across layers with optional managed-only policy.
 *
 * When managedOnly=true (dogfood admin), strips all non-managed layers so only
 * the managed hook set runs. Default false keeps full merge order so local
 * hooks win (per lightweight user-control principle).
 *
 * Never mutates input layers. Pure function suitable for extension seam.
 */
export function resolveHooks(
  layers: readonly HookLayer[],
  options: { readonly managedOnly?: boolean } = {}
): readonly HookInvocation[] {
  const { managedOnly = false } = options;

  if (managedOnly) {
    return layers
      .filter((layer) => layer.name === "managed")
      .flatMap((layer) => layer.invocations);
  }

  // Preserve declared layer order; local/user typically listed first so they win
  return layers.flatMap((layer) => layer.invocations);
}
