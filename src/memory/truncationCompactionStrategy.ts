/**
 * Truncation compaction strategy for memory groups.
 * Hard-drops oldest groups until the set is under maxGroups.
 * Used under context pressure to preserve recent history while bounding growth.
 * Pure function; no side effects; caller manages persistence.
 */

export function compact<T>(messages: readonly T[], maxGroups: number): T[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  if (maxGroups <= 0) {
    return [];
  }
  if (messages.length <= maxGroups) {
    return [...messages];
  }
  // Hard-drop oldest: keep the most recent maxGroups groups
  return messages.slice(messages.length - maxGroups);
}
