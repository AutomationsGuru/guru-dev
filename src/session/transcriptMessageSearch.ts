import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * TranscriptMessageSearch
 *
 * In-memory keyword index over session transcript messages.
 * Returns ranked hits with agentId, messageId, and a contextual snippet.
 *
 * Designed as a small, self-contained utility (no core mutation, registers
 * capability at the session layer). Fits the lightweight runtime: simple
 * string matching + occurrence scoring, no external index deps.
 *
 * Owned by IDEA-F178-MSG-SEARCH-01. One frozen seam: new module, no edits
 * to agentSession or compaction.
 */

export interface TranscriptMessage {
  readonly agentId: string;
  readonly messageId: string;
  readonly content: string;
  readonly role?: ChatTurnMessage["role"];
}

export interface SearchHit {
  readonly agentId: string;
  readonly messageId: string;
  readonly snippet: string;
  readonly score: number;
}

export class TranscriptMessageSearch {
  private indexData: TranscriptMessage[] = [];

  /**
   * Replace the current index with the provided messages.
   * Call before search; cheap full rebuild for transcript-sized corpora.
   */
  index(messages: readonly TranscriptMessage[]): void {
    this.indexData = messages.map((m) => ({ ...m }));
  }

  /**
   * Keyword search (case-insensitive contains).
   * Ranks by match count (simple relevance), returns snippet centered on first hit.
   */
  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const msg of this.indexData) {
      const lower = msg.content.toLowerCase();
      const matches = lower.match(new RegExp(q, "gi"));
      if (matches) {
        const firstIdx = lower.indexOf(q);
        const start = Math.max(0, firstIdx - 40);
        const end = Math.min(msg.content.length, firstIdx + q.length + 80);
        let snippet = msg.content.slice(start, end);
        if (start > 0) snippet = "..." + snippet;
        if (end < msg.content.length) snippet = snippet + "...";

        hits.push({
          agentId: msg.agentId,
          messageId: msg.messageId,
          snippet,
          score: matches.length,
        });
      }
    }

    // Rank: higher score first; stable for equal scores
    hits.sort((a, b) => b.score - a.score || a.messageId.localeCompare(b.messageId));
    return hits;
  }

  /** Current indexed count (for tests / debug). */
  get size(): number {
    return this.indexData.length;
  }
}
