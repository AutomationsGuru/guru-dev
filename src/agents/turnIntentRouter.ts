import { z } from "zod";

import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * Turn Intent Router (F312 — agent-squad Kit K1).
 *
 * Pure classifier that selects the best specialist agent for a user turn from
 * a catalog of agents with name + description, using turn content + conversation
 * history as features. A heuristic keyword-matching classifier is the default;
 * the classifier slot (R-AS-CLASS-SLOT / F315) makes it swappable later.
 *
 * Architecture note: this is an extension-registered module, not core. Core
 * knows nothing about turn-intent routing — the extension seam attaches it
 * without editing core, in compliance with the frozen-extension-seam rule (§1.2).
 */

// ── Agent Catalog ───────────────────────────────────────────────────────────

export const AgentCatalogEntrySchema = z
  .object({
    /** Stable agent identifier (slug pattern, same as RoleSlug). */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u),
    /** Human-readable label. */
    label: z.string().trim().min(1).max(80),
    /**
     * Description used as the routing feature — the classifier matches turn
     * content against this text. Keep it keyword-rich: domains, tools, verbs.
     * Examples: "system administration, shell scripting, devops, docker, kubernetes"
     * or "frontend react typescript css tailwind ui components".
     */
    description: z.string().trim().min(1).max(500),
    /** Optional tags for multi-dimensional classification. */
    tags: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntrySchema>;

// ── Route Receipt ───────────────────────────────────────────────────────────

/**
 * Confidence level for a routing decision. Named tiers instead of raw floats
 * so consumers can branch on the level without magic numbers.
 */
export const RouteConfidenceSchema = z.enum(["high", "medium", "low", "fallback"]);

export type RouteConfidence = z.infer<typeof RouteConfidenceSchema>;

export const TurnIntentRouteReceiptSchema = z
  .object({
    /** The selected agent id (matches an AgentCatalogEntry.id). */
    agentId: z.string().min(1),
    /** Human-readable label of the selected agent. */
    agentLabel: z.string().min(1),
    /** Confidence tier for this routing decision. */
    confidence: RouteConfidenceSchema,
    /** Why this agent was selected — short explanation for the operator. */
    reason: z.string().min(1),
    /** Matched keywords that drove the decision (empty on fallback). */
    matchedKeywords: z.array(z.string()).default([])
  })
  .strict();

export type TurnIntentRouteReceipt = z.infer<typeof TurnIntentRouteReceiptSchema>;

// ── Default agent ───────────────────────────────────────────────────────────

/** The agent id selected when no specialist matches. */
export const DEFAULT_AGENT_ID = "general";

/**
 * The classifier never returns "no agent" — unknown intent always resolves to
 * the default agent. This keeps the harness running while recording that the
 * decision was a fallback so a later compile step can examine fallback rates.
 */

// ── Tokenisation ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some",
  "such", "no", "only", "own", "same", "than", "too", "very", "just",
  "it", "its", "this", "that", "these", "those", "i", "me", "my",
  "we", "our", "you", "your", "he", "she", "they", "them", "what",
  "which", "who", "whom", "how", "when", "where", "why"
]);

const MIN_TOKEN_LENGTH = 2;

/**
 * Turn a free-text string into a deduplicated, lowercased set of non-stop
 * tokens. Each token must be at least MIN_TOKEN_LENGTH characters.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  // Split on word boundaries and normalise.
  const raw = text.toLowerCase().split(/[^a-z0-9]+/u);
  for (const token of raw) {
    if (token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token)) {
      tokens.add(token);
    }
  }
  return tokens;
}

// ── History helpers ─────────────────────────────────────────────────────────

/**
 * Extract tokens from the last N user messages in conversation history.
 * Recent turns can disambiguate an otherwise vague current turn — e.g. "fix it"
 * after a tech-heavy exchange resolves to the tech specialist.
 */
function historyTokens(history: readonly ChatTurnMessage[], lastNTurns: number): Set<string> {
  const tokens = new Set<string>();
  const userTurns = history.filter((message) => message.role === "user");
  const recent = userTurns.slice(-Math.max(1, lastNTurns));
  for (const turn of recent) {
    for (const token of tokenize(turn.content)) {
      tokens.add(token);
    }
  }
  return tokens;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

interface ScoredEntry {
  readonly entry: AgentCatalogEntry;
  readonly score: number;
  readonly matchedKeywords: string[];
}

const HIGH_CONFIDENCE_THRESHOLD = 0.5;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.15;
const HISTORY_LOOKBACK = 3;

/**
 * Score each catalog entry against the combined turn + history token set.
 * Scoring formula:
 *   score = matchedKeywordCount / descriptionTokenCount
 * Tags also contribute: each matched tag adds 0.1 (bonus, uncapped).
 */
function scoreCatalog(
  catalog: readonly AgentCatalogEntry[],
  turnTokens: ReadonlySet<string>,
  histTokens: ReadonlySet<string>
): ScoredEntry[] {
  const combined = new Set([...turnTokens, ...histTokens]);

  return catalog.map((entry) => {
    const descTokens = tokenize(entry.description);
    if (descTokens.size === 0) {
      return { entry, score: 0, matchedKeywords: [] };
    }

    const matched: string[] = [];
    for (const token of descTokens) {
      if (combined.has(token)) {
        matched.push(token);
      }
    }

    // Base score: fraction of description tokens matched by the turn.
    let score = matched.length / descTokens.size;

    // Tag bonus: each matched tag adds 0.1.
    for (const tag of entry.tags) {
      const tagTokens = tokenize(tag);
      for (const tt of tagTokens) {
        if (combined.has(tt)) {
          score += 0.1;
        }
      }
    }

    return { entry, score, matchedKeywords: matched };
  });
}

function confidenceForScore(score: number): RouteConfidence {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) {
    return "high";
  }
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) {
    return "medium";
  }
  return "low";
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface RouteInput {
  /** The current user turn content. */
  readonly turn: string;
  /** Available specialist agents. Empty → fallback. */
  readonly catalog: readonly AgentCatalogEntry[];
  /** Full conversation history (user/assistant/system messages). */
  readonly history: readonly ChatTurnMessage[];
}

/**
 * Route a user turn to the best specialist agent.
 *
 * Heuristic keyword-matching classifier (the default — swappable via the
 * classifier slot, R-AS-CLASS-SLOT / F315). Given a user turn, an agent
 * catalog, and conversation history, returns a receipt recording which agent
 * was selected, with what confidence, and why.
 *
 * Fallback guarantee: always returns a receipt — if no specialist scores above
 * the noise floor, the DEFAULT_AGENT_ID ("general") is chosen with confidence
 * "fallback". The caller never gets null / "cannot route."
 *
 * Purely synchronous and allocation-free beyond the receipt object.
 */
export function route(input: RouteInput): TurnIntentRouteReceipt {
  const { turn, catalog, history } = input;

  // Empty or whitespace-only turn → immediate fallback.
  const trimmed = turn.trim();
  if (trimmed.length === 0) {
    return {
      agentId: DEFAULT_AGENT_ID,
      agentLabel: "General",
      confidence: "fallback",
      reason: "Empty turn — routed to the default agent.",
      matchedKeywords: []
    };
  }

  // Empty catalog → fallback (no specialists to choose from).
  if (catalog.length === 0) {
    return {
      agentId: DEFAULT_AGENT_ID,
      agentLabel: "General",
      confidence: "fallback",
      reason: "No specialist agents registered — routed to the default agent.",
      matchedKeywords: []
    };
  }

  const turnTokens = tokenize(trimmed);
  const histTokens = historyTokens(history, HISTORY_LOOKBACK);

  // Score every entry.
  const scored = scoreCatalog(catalog, turnTokens, histTokens);
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;

  // Noise floor: a score of 0 means no keyword matched at all.
  if (best.score === 0) {
    return {
      agentId: DEFAULT_AGENT_ID,
      agentLabel: "General",
      confidence: "fallback",
      reason: trimLength(trimmed) > 15
        ? `No specialist matched "${trimmed.slice(0, 40)}..." — routed to the default agent.`
        : `No specialist matched "${trimmed}" — routed to the default agent.`,
      matchedKeywords: []
    };
  }

  const confidence = confidenceForScore(best.score);
  const matched = best.matchedKeywords;

  return {
    agentId: best.entry.id,
    agentLabel: best.entry.label,
    confidence,
    reason:
      matched.length > 0
        ? `Matched keywords: ${matched.slice(0, 5).join(", ")}${matched.length > 5 ? ` +${matched.length - 5} more` : ""}.`
        : `Selected "${best.entry.label}" based on description match.`,
    matchedKeywords: matched
  };
}

function trimLength(s: string): number {
  return s.replace(/\s+/gu, " ").trim().length;
}

// ── Classifier slot (F315) ──────────────────────────────────────────────────

/**
 * Pluggable classifier type. The default is the heuristic keyword matcher
 * above; a model-based or rules-based classifier can be swapped in through
 * this slot without changing any consumer.
 */
export type TurnClassifier = (input: RouteInput) => TurnIntentRouteReceipt;

/**
 * The active classifier. Starts as the heuristic default; swap via
 * `setClassifier()`. Consumers always call `classify()` — never `route()`
 * directly — so the classifier is fully pluggable (R-AS-CLASS-SLOT).
 */
let activeClassifier: TurnClassifier = route;

/** Replace the active classifier. */
export function setClassifier(classifier: TurnClassifier): void {
  activeClassifier = classifier;
}

/** Reset to the built-in heuristic classifier. */
export function resetClassifier(): void {
  activeClassifier = route;
}

/** Classify a turn through the currently active classifier. */
export function classify(input: RouteInput): TurnIntentRouteReceipt {
  return activeClassifier(input);
}
