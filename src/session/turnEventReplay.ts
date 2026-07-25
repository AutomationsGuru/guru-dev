import { createHash } from "node:crypto";

import { hashTurnEvent, parseTurnEventPack, type TurnEventPack } from "./turnEventLog.js";

/**
 * replayDryRun — offline verification of a turn event export pack
 * (IDEA-F163-TURN-REPLAY-01 / R-ZG-REPLAY, Zagens K7 golden replay).
 *
 * "Dry run" means exactly that: no model calls, no tool execution, no side
 * effects. The replay asserts sequence integrity — every event hash matches
 * the pack's entry hashes and head, seq values are 1..N contiguous, turns are
 * non-decreasing, and every event kind is one of user/assistant/tool/decision
 * (enforced by schema parse). The returned event list is the verified
 * decision order a caller can diff against an expected trace.
 */

export interface TurnReplayResult {
  readonly ok: boolean;
  readonly pack: TurnEventPack;
  /** The events in verified replay order (=== pack order). */
  readonly events: TurnEventPack["events"];
  /** Distinct turns covered, in first-appearance order. */
  readonly turns: readonly number[];
  readonly checks: {
    readonly count: number;
    readonly hashesVerified: number;
    readonly sequenceOk: boolean;
    readonly turnsMonotonic: boolean;
  };
}

/** Thrown when a pack fails sequence-integrity verification. */
export class TurnReplayError extends Error {
  readonly code: TurnReplayFailureCode;

  constructor(code: TurnReplayFailureCode, message: string) {
    super(message);
    this.name = "TurnReplayError";
    this.code = code;
  }
}

export type TurnReplayFailureCode =
  | "invalid-pack"
  | "hash-mismatch"
  | "head-mismatch"
  | "sequence-gap"
  | "turn-regression";

/**
 * Verify a pack and return the replay summary. Accepts a parsed pack or any
 * untrusted value (re-validated through the schema). Throws TurnReplayError
 * on the first integrity failure — a corrupt pack never reports ok.
 */
export function replayDryRun(rawPack: unknown): TurnReplayResult {
  let pack: TurnEventPack;
  try {
    pack = parseTurnEventPack(rawPack);
  } catch (error) {
    throw new TurnReplayError(
      "invalid-pack",
      `pack failed schema validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let hashesVerified = 0;
  for (let index = 0; index < pack.events.length; index += 1) {
    // Schema guarantees events.length === entryHashes.length; the indexed reads
    // are safe but typed as possibly-undefined under noUncheckedIndexedAccess.
    const event = pack.events[index]!;
    const recordedHash = pack.entryHashes[index]!;
    const expectedSeq = index + 1;
    if (event.seq !== expectedSeq) {
      throw new TurnReplayError(
        "sequence-gap",
        `event at index ${index} has seq ${event.seq}, expected ${expectedSeq}`
      );
    }
    const actual = hashTurnEvent(event);
    if (actual !== recordedHash) {
      throw new TurnReplayError(
        "hash-mismatch",
        `event seq ${event.seq} hash ${actual} does not match entryHashes[${index}] ${recordedHash}`
      );
    }
    hashesVerified += 1;
  }

  const recomputedHead = computeHead(pack.entryHashes);
  if (recomputedHead !== pack.head) {
    throw new TurnReplayError(
      "head-mismatch",
      `recomputed head ${recomputedHead} does not match pack head ${pack.head}`
    );
  }

  let turnsMonotonic = true;
  const turns: number[] = [];
  for (const event of pack.events) {
    const previous = turns[turns.length - 1];
    if (previous !== undefined && event.turn < previous) {
      turnsMonotonic = false;
      throw new TurnReplayError(
        "turn-regression",
        `event seq ${event.seq} regresses to turn ${event.turn} after turn ${previous}`
      );
    }
    if (previous !== event.turn) turns.push(event.turn);
  }

  return {
    ok: true,
    pack,
    events: pack.events,
    turns,
    checks: {
      count: pack.events.length,
      hashesVerified,
      sequenceOk: true,
      turnsMonotonic
    }
  };
}

function computeHead(entryHashes: readonly string[]): string {
  // Mirror of TurnEventLog.exportPack: sha256 over newline-joined entry hashes.
  // Recomputed locally so a forged head cannot ride along with valid entries.
  return createHash("sha256").update(entryHashes.join("\n")).digest("hex");
}
