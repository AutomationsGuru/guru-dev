export function nextProvider(
  rank: readonly string[],
  failedIds: readonly string[]
): string | undefined {
  if (!Array.isArray(rank) || rank.length === 0) {
    return undefined;
  }

  // Unknown/malformed rank fails closed — validate every entry before picking.
  for (const id of rank) {
    if (typeof id !== "string" || id.length === 0) {
      return undefined;
    }
  }

  const failed = new Set(failedIds ?? []);

  for (const id of rank) {
    if (!failed.has(id)) {
      return id;
    }
  }

  // all failed or no remaining usable
  return undefined;
}
