/**
 * Remember pass (F175, R-LT-REMEMBER — idea kit K4 "explicit remember/reflect",
 * Letta-code review 2026-07-19). From a transcript summary and the memory
 * blocks already on file, produce structured `MemoryUpdateProposal[]` for
 * operator approve/reject.
 *
 * This module is PROPOSAL-ONLY by contract: it never writes to the store,
 * never auto-applies, and never mutates its inputs. An update reaches the
 * memory organ only after the operator approves it — that keeps §3.5 "no
 * ungoverned self-improvement" binding on the learn path (REVIEW.md hard rule:
 * "memory rewrite cannot remove hard limits or elevate spend without operator").
 *
 * The recognizer is a hand-rolled heuristic (zero runtime dependencies, no
 * model call, no network), deterministic: same input → same proposals. A
 * model-backed extraction pass can compose behind this same proposal surface
 * later without changing the operator gate.
 */

/** An existing memory block the pass may propose updates to. */
export interface ExistingMemoryBlock {
  readonly id: string;
  readonly text: string;
}

export interface ProposeUpdatesInput {
  /** Transcript / session summary to reflect on. */
  readonly summary: string;
  /** Blocks already stored, so the pass can target update-vs-create honestly. */
  readonly existingBlocks: readonly ExistingMemoryBlock[];
}

export interface MemoryUpdateProposal {
  /**
   * Target block id — an existing block id for `update`, or a derived
   * kebab-case slug for a proposed new block.
   */
  readonly blockId: string;
  /** Proposed full text for the block after the update. */
  readonly proposedText: string;
  /** Why this proposal exists — evidence for the operator's approve/reject. */
  readonly rationale: string;
  readonly action: "create" | "update";
  readonly confidence: number;
}

/** Number of leading sentences of the summary treated as learning candidates. */
const MAX_CANDIDATE_SENTENCES = 5;
const MAX_PROPOSALS = 3;
const MIN_SENTENCE_WORDS = 4;

/** Token overlap (Jaccard over >=3-char lowercase tokens) used to match a candidate to an existing block. */
function tokenSet(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 3)
  );
}

function overlapScore(candidate: ReadonlySet<string>, block: ReadonlySet<string>): number {
  if (candidate.size === 0 || block.size === 0) return 0;
  let shared = 0;
  for (const token of candidate) {
    if (block.has(token)) shared += 1;
  }
  return shared / (candidate.size + block.size - shared);
}

/** Derive a kebab-case block id from candidate text (3-64 chars, a-z0-9-). */
function deriveBlockId(text: string, taken: ReadonlySet<string>): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/^-+|-+$/gu, "");
  const seed = base.length >= 3 ? base : `learned-${base || "note"}`;
  let id = seed;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${seed}-${suffix}`.slice(0, 64);
    suffix += 1;
  }
  return id;
}

/**
 * From a summary, propose memory block updates. Empty / whitespace-only
 * summaries yield no proposals. Non-empty summaries yield at most
 * MAX_PROPOSALS proposals: the strongest non-trivial sentences, each either
 * updating the best-overlapping existing block (action "update", proposal
 * text = existing text + appended learning) or creating a new block
 * (action "create"). Inputs are never mutated; nothing is written.
 */
export function proposeUpdates(input: ProposeUpdatesInput): MemoryUpdateProposal[] {
  const summary = input.summary.trim();
  if (summary.length === 0) return [];

  const sentences = summary
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/u).length >= MIN_SENTENCE_WORDS)
    .slice(0, MAX_CANDIDATE_SENTENCES);
  if (sentences.length === 0) return [];

  const blocks = input.existingBlocks.map((block) => ({
    id: block.id,
    text: block.text,
    tokens: tokenSet(block.text)
  }));
  const takenIds = new Set(blocks.map((block) => block.id));

  const proposals: MemoryUpdateProposal[] = [];
  for (const sentence of sentences) {
    if (proposals.length >= MAX_PROPOSALS) break;

    const candidateTokens = tokenSet(sentence);
    let best: { block: (typeof blocks)[number]; score: number } | undefined;
    for (const block of blocks) {
      const score = overlapScore(candidateTokens, block.tokens);
      if (best === undefined || score > best.score) best = { block, score };
    }

    if (best !== undefined && best.score >= 0.25) {
      const { block } = best;
      if (block.text.includes(sentence)) continue; // already captured — no redundant proposal
      proposals.push({
        blockId: block.id,
        proposedText: `${block.text}\n\n${sentence}`,
        rationale: `Summary sentence overlaps existing block "${block.id}" (score ${best.score.toFixed(2)}); propose appending the new learning.`,
        action: "update",
        confidence: Math.min(1, 0.5 + best.score / 2)
      });
    } else {
      const blockId = deriveBlockId(sentence, takenIds);
      takenIds.add(blockId);
      proposals.push({
        blockId,
        proposedText: sentence,
        rationale: "Summary records a learning with no sufficiently similar existing block; propose a new memory block for operator review.",
        action: "create",
        confidence: 0.5
      });
    }
  }
  return proposals;
}
