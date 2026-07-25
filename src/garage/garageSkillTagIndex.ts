/**
 * Garage skill tag index (IDEA-F602-TAGIDX-01, R-TAGIDX-01).
 *
 * Pure inverted index of skills by tag. Callers feed skill id + tags; the
 * index answers "which skill ids carry this tag?" with a stable sorted list.
 * No filesystem, no garage I/O, no schema coupling — garage inject / select
 * paths can hang off this without editing core.
 */

/** One skill's contribution to the tag index. */
export interface SkillTagEntry {
  /** Skill identity (garage layer id / skill id). */
  readonly id: string;
  /** Tags associated with the skill (module, language, category, …). */
  readonly tags: readonly string[];
}

/**
 * tag → frozen, lexicographically sorted unique skill ids.
 * Built by {@link buildIndex}; read via {@link queryByTag}.
 */
export type SkillTagIndex = ReadonlyMap<string, readonly string[]>;

const EMPTY_IDS: readonly string[] = Object.freeze([]);

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build an inverted tag → skill-id index.
 *
 * - Empty / whitespace-only skill ids are skipped.
 * - Empty / whitespace-only tags are skipped (they never become keys).
 * - Duplicate (id, tag) pairs collapse to one entry.
 * - Ids under each tag are unique and sorted lexicographically so query
 *   results are stable regardless of input order.
 */
export function buildIndex(skills: readonly SkillTagEntry[]): SkillTagIndex {
  const buckets = new Map<string, Set<string>>();

  for (const skill of skills) {
    const id = normalizeToken(skill?.id);
    if (!id) {
      continue;
    }
    const tags = skill.tags ?? [];
    for (const raw of tags) {
      const tag = normalizeToken(raw);
      if (!tag) {
        continue;
      }
      let set = buckets.get(tag);
      if (!set) {
        set = new Set<string>();
        buckets.set(tag, set);
      }
      set.add(id);
    }
  }

  const index = new Map<string, readonly string[]>();
  for (const [tag, set] of buckets) {
    const sorted = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    index.set(tag, Object.freeze(sorted));
  }
  return index;
}

/**
 * Return the stable sorted skill ids for `tag`.
 *
 * Empty / whitespace-only tags and unknown tags yield an empty list
 * (never `undefined`) so callers can iterate without null guards.
 */
export function queryByTag(index: SkillTagIndex, tag: string): readonly string[] {
  const key = normalizeToken(tag);
  if (!key) {
    return EMPTY_IDS;
  }
  return index.get(key) ?? EMPTY_IDS;
}
