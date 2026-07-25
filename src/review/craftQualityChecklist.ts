export type CraftQualityCriteria = Readonly<Record<string, boolean>>;

/** A ship claim is permitted only when every named craft criterion passes. */
export function evaluate(criteria: CraftQualityCriteria): boolean {
  return Object.values(criteria).every(Boolean);
}
