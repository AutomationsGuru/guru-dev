import { detectPotentialSecrets } from "../safety/policyGuard.js";
import { containsSecretValue } from "../safety/secretSafety.js";
import { extractLinks } from "./frontmatter.js";
import {
  MEMORY_BODY_HARD_CAP,
  MEMORY_BODY_SOFT_CAP,
  MemoryRememberInputSchema,
  slugifyFactName,
  type MemoryFact,
  type MemoryGetResult,
  type MemoryRememberInput,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemoryWriteResult
} from "./schemas.js";

export interface MemoryFactEntry {
  readonly fact: MemoryFact;
  readonly body: string;
}

export interface MemoryRememberPolicyOptions {
  readonly timestamp: string;
  readonly sessionId?: string;
}

export type MemoryRememberPreflight =
  | {
      readonly kind: "blocked";
      readonly result: MemoryWriteResult;
    }
  | {
      readonly kind: "ready";
      readonly input: MemoryRememberInput;
    };

export type ReadyMemoryRememberPreflight = Extract<MemoryRememberPreflight, { readonly kind: "ready" }>;

export type MemoryRememberPlan =
  | {
      readonly kind: "blocked";
      readonly result: MemoryWriteResult;
    }
  | {
      readonly kind: "create" | "update";
      readonly name: string;
      readonly fact: MemoryFact;
      readonly body: string;
      readonly result: MemoryWriteResult;
    };

/** Tokenization shared by similarity checks and search ranking. */
export function tokenizeMemoryText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 2)
  );
}

/** Proportion of the smaller token set present in both sets. */
export function memoryTokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits += 1;
    }
  }
  return hits / Math.min(left.size, right.size);
}

/** Parse and apply entry-independent write gates before any backend access. */
export function preflightMemoryRemember(rawInput: unknown): MemoryRememberPreflight {
  const input = MemoryRememberInputSchema.parse(rawInput);
  const blockers = memoryWriteBlockers(input);
  if (blockers.length > 0) {
    return {
      kind: "blocked",
      result: { status: "blocked", summary: "Write blocked by the secret-safety gate.", blockers }
    };
  }
  if (input.body.length > MEMORY_BODY_HARD_CAP) {
    return {
      kind: "blocked",
      result: {
        status: "blocked",
        summary: "Write blocked: body exceeds the 32KB hard cap.",
        blockers: [`body is ${input.body.length} bytes (> ${MEMORY_BODY_HARD_CAP}); split this fact into linked smaller facts`]
      }
    };
  }
  return { kind: "ready", input };
}

/** Decide a write from preflighted input and facts loaded by the backend. */
export function planPreflightedMemoryRemember(
  preflight: ReadyMemoryRememberPreflight,
  entries: readonly MemoryFactEntry[],
  options: MemoryRememberPolicyOptions
): MemoryRememberPlan {
  const { input } = preflight;

  const name = input.name ?? slugifyFactName(input.title);
  const existing = entries.find((entry) => entry.fact.name === name);
  if (existing) {
    const body = input.edit === "append" ? `${existing.body}\n\n${input.body}` : input.body;
    if (body.length > MEMORY_BODY_HARD_CAP) {
      return {
        kind: "blocked",
        result: {
          status: "blocked",
          summary: "Update blocked: appended body exceeds the 32KB hard cap.",
          blockers: [`resulting body would be ${body.length} bytes (> ${MEMORY_BODY_HARD_CAP}); split this fact`]
        }
      };
    }
    const fact: MemoryFact = {
      ...existing.fact,
      title: input.title,
      description: input.description,
      type: input.type,
      confidence: input.confidence,
      updatedAt: options.timestamp
    };
    return {
      kind: "update",
      name,
      fact,
      body,
      result: { status: "updated", name, summary: `Updated [[${name}]] in place (${input.edit}).`, blockers: [] }
    };
  }

  if (!input.name) {
    const inputTokens = tokenizeMemoryText(`${input.title} ${input.description}`);
    for (const entry of entries) {
      const normalizedEqual = normalizeMemoryTitle(entry.fact.title) === normalizeMemoryTitle(input.title);
      const similar = memoryTokenOverlap(inputTokens, tokenizeMemoryText(`${entry.fact.title} ${entry.fact.description}`)) > 0.6;
      if (normalizedEqual || similar) {
        return {
          kind: "blocked",
          result: {
            status: "blocked",
            summary: `Similar to existing fact [[${entry.fact.name}]] — update it instead, or pass an explicit name to confirm a new fact.`,
            blockers: [`similar-to:${entry.fact.name}`]
          }
        };
      }
    }
  }

  const fact: MemoryFact = {
    name,
    title: input.title,
    description: input.description,
    type: input.type,
    createdAt: options.timestamp,
    updatedAt: options.timestamp,
    confidence: input.confidence,
    ...(options.sessionId ? { originSessionId: options.sessionId } : {})
  };
  const softCapNote = input.body.length > MEMORY_BODY_SOFT_CAP ? " (over the 16KB soft cap — consider splitting)" : "";
  return {
    kind: "create",
    name,
    fact,
    body: input.body,
    result: { status: "created", name, summary: `Remembered [[${name}]]${softCapNote}.`, blockers: [] }
  };
}

/** Convenience API for callers that already have loaded facts. */
export function planMemoryRemember(
  rawInput: MemoryRememberInput,
  entries: readonly MemoryFactEntry[],
  options: MemoryRememberPolicyOptions
): MemoryRememberPlan {
  const preflight = preflightMemoryRemember(rawInput);
  return preflight.kind === "blocked" ? preflight : planPreflightedMemoryRemember(preflight, entries, options);
}

/** Build the common fact read response from backend-loaded entries. */
export function buildMemoryGetResult(name: string, entries: readonly MemoryFactEntry[], now: Date): MemoryGetResult {
  const entry = entries.find((candidate) => candidate.fact.name === name);
  if (!entry) {
    return { found: false, links: [], backlinks: [], danglingLinks: [], summary: `No memory fact named '${name}'.` };
  }
  const links = extractLinks(entry.body);
  const names = new Set(entries.map((candidate) => candidate.fact.name));
  const backlinks = entries
    .filter((candidate) => candidate.fact.name !== name && extractLinks(candidate.body).includes(name))
    .map((candidate) => candidate.fact.name);
  const danglingLinks = links.filter((link) => !names.has(link));
  const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(entry.fact.updatedAt)) / 86_400_000));
  return {
    found: true,
    fact: entry.fact,
    body: entry.body,
    stalenessBanner: `This memory is ${ageDays} day${ageDays === 1 ? "" : "s"} old. Memories are point-in-time observations, not live state — verify against current code/state before asserting as fact.`,
    links: [...links],
    backlinks,
    danglingLinks,
    summary: `[[${name}]] (${entry.fact.type}, updated ${entry.fact.updatedAt}).`
  };
}

/** Search and rank backend-loaded entries using one shared scoring policy. */
export function searchMemoryEntries(input: MemorySearchInput, entries: readonly MemoryFactEntry[]): MemorySearchResult {
  const queryTokens = tokenizeMemoryText(input.terms);
  const hits = entries
    .filter((entry) => (input.type ? entry.fact.type === input.type : true))
    .map((entry) => {
      const haystack = tokenizeMemoryText(`${entry.fact.name} ${entry.fact.title} ${entry.fact.description}`);
      let score = 0;
      for (const token of queryTokens) {
        if (haystack.has(token)) {
          score += 1;
        }
      }
      return { entry, score: queryTokens.size > 0 ? score / queryTokens.size : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit)
    .map(({ entry, score }) => ({
      name: entry.fact.name,
      title: entry.fact.title,
      description: entry.fact.description,
      type: entry.fact.type,
      updatedAt: entry.fact.updatedAt,
      score: Number(score.toFixed(3))
    }));
  return {
    hits,
    summary: hits.length > 0 ? `${hits.length} memory fact(s) matched — read with memory_get.` : "No memory facts matched."
  };
}

function normalizeMemoryTitle(title: string): string {
  return title.trim().toLowerCase();
}

function memoryWriteBlockers(input: MemoryRememberInput): string[] {
  const fields = [
    { name: "title", value: input.title },
    { name: "description", value: input.description },
    { name: "body", value: input.body }
  ];
  const blockers = detectPotentialSecrets(fields).map(
    (match) => `memory write blocked: potential secret (${match.kind}) detected in ${match.name} — memory stores must never hold secret values`
  );
  for (const field of fields) {
    if (containsSecretValue(field.value)) {
      blockers.push(`memory write blocked: token-shaped value detected in ${field.name} — memory stores must never hold secret values`);
    }
  }
  return blockers;
}
