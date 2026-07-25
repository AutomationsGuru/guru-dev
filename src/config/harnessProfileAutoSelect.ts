/**
 * Harness profile auto-selection by task tags scoring.
 *
 * Picks the profile whose supported tags best match the requested task tags.
 * Score = count of overlapping tags. Highest score wins.
 */

export interface HarnessProfile {
  /** Unique profile identifier */
  id: string;
  /** Human-readable profile name */
  name: string;
  /** Tags this profile supports (e.g., ["code", "debug", "refactor"]) */
  tags: string[];
}

/**
 * Select the best harness profile for a set of task tags.
 *
 * @param profiles - Available harness profiles to choose from
 * @param tags - Task tags describing the work to be performed
 * @returns The profile with the highest tag-overlap score, or null if no profiles
 *
 * Scoring: number of tags in the profile that are also in the requested tags.
 * Ties are resolved by stable iteration order (first highest wins).
 */
export function autoSelect(
  profiles: HarnessProfile[],
  tags: string[]
): HarnessProfile | null {
  if (profiles.length === 0) {
    return null;
  }

  let best: HarnessProfile | null = null;
  let bestScore = -1;

  for (const profile of profiles) {
    const score = profile.tags.filter((t) => tags.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }

  return best;
}
