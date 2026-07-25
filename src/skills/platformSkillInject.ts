import { computeLayerHash, type GarageLayer, type GarageManifest } from "../garage/manifest.js";

/**
 * Returns requested skills whose canonical garage layers are built, verified,
 * fresh, hash-bound, and tied to a done packet. It never loads or mutates them.
 */
export function selectForWorkspace(
  flags: readonly string[],
  manifests: readonly GarageManifest[]
): GarageLayer[] {
  if (flags.length === 0) {
    return [];
  }

  const requestedIds = new Set(flags);

  return manifests.flatMap((manifest) =>
    manifest.layers.filter(
      (layer) =>
        layer.kind === "skill" &&
        layer.provenance === "built" &&
        layer.status === "verified" &&
        layer.staleFlag === false &&
        layer.verificationHash === computeLayerHash(layer) &&
        layer.donePacketRef.trim().length > 0 &&
        requestedIds.has(layer.id)
    )
  );
}
