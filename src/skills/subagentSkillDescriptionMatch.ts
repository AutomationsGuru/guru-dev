/**
 * Subagent Skill Description Match (G1055)
 *
 * Lightweight match gate: pick skills whose description tokens intersect task text.
 * Pure function, no side effects. Returns skills with any token overlap.
 */

/**
 * Skill-like shape for matching (minimal surface).
 */
export interface SkillLike {
  name: string;
  description?: string | null;
}

/**
 * Result of matching a skill against a task.
 */
export interface MatchResult<T extends SkillLike> {
  skill: T;
  matchedTokens: string[];
}

/**
 * Returns skills whose description tokens intersect with task tokens.
 * Tokenization: whitespace split, case-insensitive comparison.
 * Empty task or no intersection → returns empty array.
 *
 * @param task - Task/query text to match against skill descriptions
 * @param skills - Array of skills with optional descriptions
 * @returns Array of skills with at least one matching token (or empty if no match)
 */
export function match<T extends SkillLike>(task: string, skills: T[]): T[] {
  const taskTokens = tokenize(task);
  if (taskTokens.length === 0) {
    return [];
  }

  return skills.filter((skill) => {
    const descTokens = tokenize(skill.description);
    return descTokens.some((dt) => taskTokens.includes(dt));
  });
}

/**
 * Detailed match returning matched tokens per skill.
 */
export function matchSkillDescriptions<T extends SkillLike>(
  task: string,
  skills: T[]
): MatchResult<T>[] {
  const taskTokens = tokenize(task);
  if (taskTokens.length === 0) {
    return [];
  }

  const results: MatchResult<T>[] = [];
  for (const skill of skills) {
    const descTokens = tokenize(skill.description);
    const matched = descTokens.filter((dt) => taskTokens.includes(dt));
    if (matched.length > 0) {
      results.push({ skill, matchedTokens: matched });
    }
  }
  return results;
}

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
