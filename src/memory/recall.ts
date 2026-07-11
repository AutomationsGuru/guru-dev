/**
 * Smart Connections — a lightweight semantic recall layer (Smart Connections
 * wave, ADR 2026-07-05-smart-connections, THERE v2 §7). A hand-rolled **BM25**
 * index over the memory organ so injected facts (and the /recall surface) are
 * ranked by RELEVANCE to the current turn, not just recency/decay.
 *
 * Zero dependency, pure, deterministic — no vector DB, no embedding model, no
 * network. BM25 is the classic sparse lexical ranker (Okapi BM25): term
 * frequency saturated by k1, document length normalized by b, terms weighted by
 * a positive inverse document frequency. It beats the old flat token-overlap
 * count because it downweights common terms and rewards rarer, more specific
 * matches — a real relevance signal from the words alone.
 */

const K1 = 1.5; // term-frequency saturation
const B = 0.75; // length normalization

/**
 * Tokenize to lowercase alphanumeric terms of length >= 2 (review 2026-07-08).
 * The old `> 2` filter dropped 2-char meaningful terms (db, js, go, ai, os, ml),
 * making them unrecallable even when they name a stored fact's subject. Both the
 * index and the query use this function, so lowering the threshold keeps them
 * aligned; single letters (a, I) stay excluded as too noisy.
 */
export function tokenizeRecall(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 2);
}

export interface RecallDoc {
  readonly id: string;
  readonly text: string;
}

interface IndexedDoc {
  readonly id: string;
  readonly tf: Map<string, number>;
  readonly length: number;
}

export interface RecallIndex {
  readonly docs: readonly IndexedDoc[];
  readonly docFreq: ReadonlyMap<string, number>;
  readonly avgLength: number;
  readonly count: number;
}

export interface RecallHit {
  readonly id: string;
  readonly score: number;
}

/** Build a BM25 index over the given documents. Empty input yields an empty index. */
export function buildRecallIndex(docs: readonly RecallDoc[]): RecallIndex {
  const indexed: IndexedDoc[] = [];
  const docFreq = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenizeRecall(doc.text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    indexed.push({ id: doc.id, tf, length: tokens.length });
    totalLength += tokens.length;
  }

  return {
    docs: indexed,
    docFreq,
    avgLength: indexed.length > 0 ? totalLength / indexed.length : 0,
    count: indexed.length
  };
}

/** BM25 idf — always positive (the +1 inside the log keeps rare terms from going negative). */
function idf(index: RecallIndex, term: string): number {
  const df = index.docFreq.get(term) ?? 0;
  return Math.log(1 + (index.count - df + 0.5) / (df + 0.5));
}

/**
 * Rank the indexed docs against `query` by BM25, best first. Returns only docs
 * that matched at least one query term (score > 0), capped at `limit` when given.
 */
export function queryRecall(index: RecallIndex, query: string, limit?: number): RecallHit[] {
  if (index.count === 0 || index.avgLength === 0) {
    return [];
  }
  const queryTerms = new Set(tokenizeRecall(query));
  if (queryTerms.size === 0) {
    return [];
  }

  const hits: RecallHit[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const term of queryTerms) {
      const freq = doc.tf.get(term);
      if (!freq) {
        continue;
      }
      const denom = freq + K1 * (1 - B + (B * doc.length) / index.avgLength);
      score += idf(index, term) * ((freq * (K1 + 1)) / denom);
    }
    if (score > 0) {
      hits.push({ id: doc.id, score });
    }
  }

  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return typeof limit === "number" ? hits.slice(0, limit) : hits;
}
