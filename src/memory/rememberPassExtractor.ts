/**
 * Remember pass extractor — the EXTRACT stage of the knowledge flywheel
 * (vision §1.6 EXTRACT → GATE → STORE → INJECT → CITE → DECAY; ideation
 * residual `IDEA-F414-REMEMBER-01`, `R-LET-REMEMBER`).
 *
 * Given a transcript, surface candidate memory facts with a confidence score.
 * This module is **pure candidate extraction only**: it reads text and returns
 * typed candidates. It does NOT store, promote, inject, cite, or decay anything
 * — the GATE/STORE stages live elsewhere and run under their own review gates.
 * Keeping extraction isolated is what lets a reviewer evaluate the signal before
 * any memory organ mutation, which preserves the §3.5 "no ungoverned
 * self-improvement" hard limit (promotion is always a separate, gated step).
 *
 * Zero dependency, pure, deterministic — no model call, no network, no store.
 * The recognizer is a hand-rolled pattern pass over the transcript lines: it
 * scores candidates by how strongly the surrounding language asserts a durable
 * fact (explicit preference / decision / definition cues beat passing chatter),
 * and de-duplicates near-identical candidates so the same fact stated twice is
 * surfaced once. Determinism (stable ordering, idempotent dedupe) is required so
 * downstream gating and tests are reproducible across runs.
 */

/** A transcript turn — a minimal speaker/text pair. `speaker` is informational. */
export interface TranscriptTurn {
  readonly speaker?: string;
  readonly text: string;
}

/** Either a raw transcript string or a list of turns; both are accepted. */
export type TranscriptInput = string | readonly TranscriptTurn[];

/** The candidate memory type this extractor can propose. */
export type RememberCandidateType =
  | "preference"
  | "decision"
  | "fact"
  | "feedback"
  | "reference";

export interface RememberCandidate {
  /** Stable, deterministic id (sha of the normalized gist) — dedupe key. */
  readonly id: string;
  /** One-line gist of the candidate fact (already trimmed/normalized). */
  readonly gist: string;
  readonly type: RememberCandidateType;
  /** Confidence in [0,1] — higher means the language asserts a durable fact. */
  readonly confidence: number;
  /** 1-based line in the transcript where the candidate was found. */
  readonly line: number;
}

/** Threshold below which a candidate is too weak to surface. */
const MIN_CONFIDENCE = 0.1;

/**
 * Cue phrases that strongly assert a durable fact. Each carries a type and a
 * weight contribution. "I prefer X" / "remember that X" / "always do Y" are the
 * highest-signal forms; a bare declarative ("the deploy runs at 2am") still
 * counts as a `fact` but at lower confidence.
 */
interface Cue {
  readonly pattern: RegExp;
  readonly type: RememberCandidateType;
  readonly weight: number;
}

const CUES: readonly Cue[] = [
  // Explicit remember/prefer/always/never — the strongest, most deliberate cues.
  { pattern: /\b(?:remember(?:ing)? to|don'?t forget to|always|never|make sure to|be sure to)\b/iu, type: "preference", weight: 0.45 },
  { pattern: /\b(?:i prefer|i'd rather|i like|i want|i need|i hate|i dislike)\b/iu, type: "preference", weight: 0.4 },
  { pattern: /\b(?:let'?s decide|we decided|decision is|decided to|going forward|ruling is|the rule is)\b/iu, type: "decision", weight: 0.4 },
  { pattern: /\b(?:please remember|note that|keep in mind|for the record|fyi|fwiw)\b/iu, type: "fact", weight: 0.3 },
  { pattern: /\b(?:that'?s wrong|that broke|this is a bug|fix(?:ing)? this|don'?t do that|should have)\b/iu, type: "feedback", weight: 0.3 },
  { pattern: /\b(?:see (?:the )?(?:docs?|manual|spec|rfc|issue|ticket|link)|reference:|source:|according to)\b/iu, type: "reference", weight: 0.3 }
];

/** Bare-declarative fallback: a colon definition or an equals/is statement of fact. */
const DECLARATIVE_PATTERN = /\b(?:is|are|equals?|means?|runs? at|lives? at|defined as)\b/iu;

/** Lines that are almost never memory-worthy (greetings, acks, pure questions). */
const NOISE_PATTERN = /^(?:hi|hey|hello|ok(?:ay)?|thanks?|cool|sure|yes|no|yep|nope|lol|hmm|k)\b[!.?\s]*$/iu;
const QUESTION_ONLY_PATTERN = /\?$/u;

/**
 * Normalize a candidate gist: collapse whitespace, strip trailing punctuation
 * noise, cap length. Two equivalent phrasings that normalize identically dedupe.
 */
function normalizeGist(raw: string): string {
  return raw
    .replace(/[\t\r\n]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .replace(/[,;:.!\s]+$/u, "")
    .slice(0, 300);
}

/**
 * Deterministic 32-bit FNV-1a hash → non-negative integer string. Not
 * cryptographic; it exists only as a stable, content-addressed dedupe key so the
 * same gist always produces the same candidate id across runs.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Split a raw string transcript into (1-based line number, text) pairs. */
function linesFromString(transcript: string): Array<{ line: number; text: string }> {
  return transcript
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text }));
}

function toLines(input: TranscriptInput): Array<{ line: number; text: string }> {
  if (typeof input === "string") {
    return linesFromString(input);
  }
  return input.map((turn, index) => ({ line: index + 1, text: turn.text }));
}

/**
 * Score a single line into a candidate, or return null if it carries no
 * memory-worthy signal. Scoring is additive over matched cues plus a small
 * declarative bonus, clamped to [0,1]; a floor of MIN_CONFIDENCE keeps the range
 * meaningful and a ceiling of 1 bounds the contract.
 */
function scoreLine(lineText: string, lineNumber: number): RememberCandidate | null {
  const gist = normalizeGist(lineText);
  if (gist.length < 3) {
    return null;
  }
  if (NOISE_PATTERN.test(lineText)) {
    return null;
  }

  let weight = 0;
  let type: RememberCandidateType = "fact";

  for (const cue of CUES) {
    if (cue.pattern.test(lineText)) {
      weight += cue.weight;
      // The first matching cue fixes the type; later cues only add weight.
      if (weight === cue.weight) {
        type = cue.type;
      }
    }
  }

  // A bare declarative with no explicit cue still counts, weakly, as a fact —
  // but a lone question does not (it asks, it does not assert).
  if (weight === 0) {
    if (QUESTION_ONLY_PATTERN.test(lineText)) {
      return null;
    }
    if (DECLARATIVE_PATTERN.test(lineText)) {
      weight = 0.15;
      type = "fact";
    } else {
      return null;
    }
  }

  // Shorter, cue-rich lines are sharper facts; pad length gives a mild penalty.
  if (gist.length > 160) {
    weight -= 0.05;
  }

  const confidence = Math.min(1, Math.max(MIN_CONFIDENCE, Math.round(weight * 1000) / 1000));
  return {
    id: fnv1a(`${type}:${gist.toLowerCase()}`),
    gist,
    type,
    confidence,
    line: lineNumber
  };
}

/**
 * Extract candidate memory facts from a transcript. Pure: returns a fresh array,
 * never mutates input, touches no store. Candidates are de-duplicated by id
 * (normalized gist + type) and ordered by appearance, then by descending
 * confidence for ties. Empty / whitespace-only input yields an empty list.
 */
export function extractRememberCandidates(input: TranscriptInput): RememberCandidate[] {
  const lines = toLines(input);
  const byId = new Map<string, RememberCandidate>();

  for (const { line, text } of lines) {
    const candidate = scoreLine(text, line);
    if (!candidate) {
      continue;
    }
    const existing = byId.get(candidate.id);
    if (!existing || candidate.confidence > existing.confidence) {
      byId.set(candidate.id, candidate);
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.line - b.line ||
      a.gist.localeCompare(b.gist)
  );
}
