/**
 * Subagent skill description match (IDEA-F407 / R-WSH-DESCMATCH).
 *
 * Pure gate: pick skills whose description tokens intersect task text.
 * Empty task or no token intersection → empty array.
 */

/** Minimal skill surface required for description matching. */
export interface SkillDescriptionLike {
  readonly name?: string;
  readonly description?: string | null;
}

/**
 * Tokenize text for description matching.
 * Whitespace-split, lowercased, empty tokens dropped. Null/blank → [].
 */
export function tokenizeDescriptionText(text: string | null | undefined): string[] {
  if (text == null) {
    return [];
  }

  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Return skills whose description tokens intersect the task text.
 *
 * Tokenization is case-insensitive whitespace split on both sides.
 * Skills with missing/blank descriptions never match.
 * Empty or whitespace-only task → [].
 * No shared tokens → [] (no intersection empty).
 */
export function match<T extends SkillDescriptionLike>(task: string, skills: readonly T[]): T[] {
  const taskTokens = new Set(tokenizeDescriptionText(task));
  if (taskTokens.size === 0) {
    return [];
  }

  if (!Array.isArray(skills) || skills.length === 0) {
    return [];
  }

  return skills.filter((skill) => {
    const descriptionTokens = tokenizeDescriptionText(skill?.description);
    if (descriptionTokens.length === 0) {
      return false;
    }

    return descriptionTokens.some((token) => taskTokens.has(token));
  });
}
