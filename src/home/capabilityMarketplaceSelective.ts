import { join } from "node:path";

/**
 * Thin catalog for selective capability marketplace install (IDEA-F500-MKT-01).
 *
 * Only `loadContext` is installed in the minimal profile. Uninstalled
 * capabilities are excluded from the catalog and from load operations.
 * This keeps the marketplace surface minimal and the home profile lean.
 *
 * Owned by builder lane for this work item only. Do not edit core or other surfaces.
 */
export interface SelectiveCapability {
  readonly name: "loadContext";
  readonly loadContext: () => Record<string, unknown>;
}

export const INSTALLED_CAPABILITIES: SelectiveCapability[] = [
  {
    name: "loadContext",
    loadContext: () => ({
      installed: true,
      scope: "selective-thin",
      note: "loadContext only; uninstalled capabilities are excluded by design"
    })
  }
];

/**
 * Load context for an installed capability only.
 * Throws for any uninstalled name so that tests can assert exclusion.
 */
export function loadContext(capabilityName: string): Record<string, unknown> {
  const found = INSTALLED_CAPABILITIES.find((c) => c.name === capabilityName);
  if (!found) {
    throw new Error(`Capability excluded (not installed in selective thin catalog): ${capabilityName}`);
  }
  return found.loadContext();
}

/**
 * Returns true when the capability is installed in this selective profile.
 */
export function isInstalled(capabilityName: string): boolean {
  return INSTALLED_CAPABILITIES.some((c) => c.name === capabilityName);
}
