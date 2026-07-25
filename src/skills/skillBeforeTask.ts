import type { SkillCatalog } from "./schemas.js";

export interface MatchSkillsOptions {
  /** Maximum number of skill IDs to return (default: unlimited). */
  readonly maxResults?: number;
}

const NOISE_WORDS = new Set([
  "about", "above", "after", "again", "all", "also", "and", "any", "are",
  "been", "before", "being", "below", "both", "but", "can", "come", "could",
  "did", "does", "doing", "down", "during", "each", "either", "else",
  "every", "few", "first", "for", "from", "further", "get", "going",
  "has", "have", "here", "how", "into", "its", "just", "know", "like",
  "look", "make", "may", "might", "more", "most", "much", "need",
  "needs", "neither", "nor", "not", "now", "off", "once", "only",
  "other", "our", "out", "over", "own", "part", "parts", "same",
  "second", "see", "shall", "should", "some", "such", "take", "than",
  "that", "their", "them", "then", "there", "these", "thing", "things",
  "this", "those", "through", "too", "under", "until", "very", "want",
  "wants", "way", "ways", "were", "what", "when", "where", "which",
  "will", "with", "work", "working", "would", "your",
]);

/**
 * Extract lowercase, deduplicated keywords from task text.
 * Filters noise words, short tokens (< 3 chars), and punctuation.
 */
function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !NOISE_WORDS.has(token));

  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      keywords.push(token);
    }
  }

  return keywords;
}

/**
 * Match task text against a skill catalog and return IDs of relevant skills.
 *
 * Uses simple keyword matching: extracts meaningful words from the task and
 * scores each skill by how many of those words appear in its id, name, or
 * description. Returns skill IDs sorted by relevance score descending, capped
 * at `options.maxResults` when set.
 *
 * Returns an empty array when the task is blank, the catalog is empty, or no
 * skills match any keywords.
 */
export function matchSkills(
  task: string,
  catalog: SkillCatalog,
  options: MatchSkillsOptions = {},
): string[] {
  const trimmed = task.trim();
  if (!trimmed || catalog.skills.length === 0) {
    return [];
  }

  const keywords = extractKeywords(trimmed);
  if (keywords.length === 0) {
    return [];
  }

  // Score each skill by keyword overlap against id + name + description.
  const scored = catalog.skills.map((skill) => {
    const haystack = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
    const score = keywords.filter((kw) => haystack.includes(kw)).length;
    return { id: skill.id, score };
  });

  const matched = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.id);

  if (options.maxResults !== undefined && matched.length > options.maxResults) {
    return matched.slice(0, options.maxResults);
  }

  return matched;
}
