/**
 * Transcript message search (IDEA-F278-TX-SEARCH-01).
 *
 * A local, in-memory keyword index over a session's chat messages. Call
 * {@link indexMessages} once to build the index, then {@link search} any number
 * of times. This is a pure, dependency-free local utility — no cloud memory,
 * no telemetry, no third-party product. Capability stays model-agnostic and
 * resolved inline; it does not delegate the loop to anything external.
 *
 * Secret safety (the five hard limits — no leaked secrets): every hit returned
 * to a caller has its content run through the canonical structural scrubber
 * (`scrubSecretValues` from `src/safety/secretSafety.js`). Redaction is enforced
 * in the code path, not in prose: a token-shaped value (API key, JWT, password
 * assignment, ...) can never reach the caller of {@link search}. The matched
 * value itself is never surfaced — only a `[redacted:...]` placeholder.
 */

import type { ChatTurnMessage } from "../model/directChat.js";
import { scrubSecretValues } from "../safety/secretSafety.js";

/** A reusable, opaque keyword index over an ordered message list. */
export interface TranscriptIndex {
  /** The indexed messages, in insertion order (role + raw content). */
  readonly messages: readonly ChatTurnMessage[];
  /** token -> ordered list of message indexes that contain it. */
  readonly tokenToMessages: ReadonlyMap<string, readonly number[]>;
}

/** A single search result. `message.content` is always secret-scrubbed. */
export interface TranscriptSearchHit {
  /** Position of the hit in the original indexed message list. */
  readonly index: number;
  /** The matching message; content is redacted of any secret value. */
  readonly message: ChatTurnMessage;
}

/** Splits text into normalized lowercase alphanumeric tokens. */
function tokenize(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  // Match runs of alphanumerics only — underscore is a separator so that
  // identifiers like `DB_PASSWORD` and `API_KEY` are searchable by their
  // constituent words (`password`, `key`). Lowercase for case-insensitive match.
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ?? [];
}

/**
 * Builds a keyword index over the given messages. The index references the
 * passed array; do not mutate it after indexing. Safe to call with an empty list.
 */
export function indexMessages(messages: readonly ChatTurnMessage[]): TranscriptIndex {
  const tokenToMessages = new Map<string, number[]>();
  const seen = new Map<number, Set<string>>();

  for (let i = 0; i < messages.length; i += 1) {
    const content = messages[i]?.content ?? "";
    const tokens = tokenize(content);
    if (tokens.length === 0) {
      continue;
    }
    const perMessage = new Set<string>();
    for (const token of tokens) {
      perMessage.add(token);
    }
    seen.set(i, perMessage);
  }

  for (const [messageIndex, perMessage] of seen) {
    for (const token of perMessage) {
      const bucket = tokenToMessages.get(token);
      if (bucket === undefined) {
        tokenToMessages.set(token, [messageIndex]);
      } else {
        bucket.push(messageIndex);
      }
    }
  }

  return { messages, tokenToMessages };
}

/**
 * Searches the index for messages containing every keyword in the query (AND
 * semantics across query terms; matches within a message are OR of its tokens).
 * Results preserve original insertion order and are de-duplicated. A blank
 * query returns an empty array. Every returned hit has its content scrubbed of
 * any secret value before it leaves this function.
 */
export function search(index: TranscriptIndex, query: string): TranscriptSearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }

  // Intersect the message-index lists for every query term (AND semantics).
  let candidate: ReadonlySet<number> | undefined;
  for (const term of terms) {
    const bucket = index.tokenToMessages.get(term);
    const matches = bucket ?? [];
    if (matches.length === 0) {
      // A term with zero matches makes the whole query empty.
      return [];
    }
    if (candidate === undefined) {
      candidate = new Set(matches);
    } else {
      const next = new Set<number>();
      for (const idx of matches) {
        if (candidate.has(idx)) {
          next.add(idx);
        }
      }
      candidate = next;
    }
    if (candidate.size === 0) {
      return [];
    }
  }

  if (candidate === undefined || candidate.size === 0) {
    return [];
  }

  // Preserve original insertion order, deduplicated (Set already dedups).
  const ordered = [...candidate].sort((a, b) => a - b);
  const hits: TranscriptSearchHit[] = [];
  for (const messageIndex of ordered) {
    const original = index.messages[messageIndex];
    if (original === undefined) {
      continue;
    }
    // Structural secret redaction (hard limit: no leaked secrets). Enforced in
    // code — every hit content is scrubbed before it reaches the caller.
    const scrubbedContent = scrubSecretValues(original.content);
    hits.push({
      index: messageIndex,
      message: { role: original.role, content: scrubbedContent },
    });
  }
  return hits;
}
