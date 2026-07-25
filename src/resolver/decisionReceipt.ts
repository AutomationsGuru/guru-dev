import { randomUUID } from "node:crypto";

import type { NeverStuckMove } from "../selfbuild/resolver.js";
import {
  DecisionReceiptSchema,
  type DecisionReceipt,
  type DecisionReceiptStore
} from "./decisionReceiptSchema.js";

/**
 * Input for appending a new decision receipt.
 *
 * The `move` field is validated through the {@link NeverStuckMoveSchema}
 * enum — an empty or invalid move is REFUSED at the schema level so the
 * resolver can never silently dead-end.
 */
export interface AppendDecisionInput {
  gap: string;
  move: NeverStuckMove;
  statement: string;
  reasons: string[];
  workPlan: string[];
  evidence: string[];
  nextCheckAt?: string;
}

/** Create a new empty decision-receipt store. */
export function createEmptyStore(): DecisionReceiptStore {
  return { decisions: [] };
}

/**
 * Append a validated decision receipt to the store.
 *
 * The receipt is parsed through {@link DecisionReceiptSchema} so every
 * invariant (non-empty move, min-length gap/reasons, UUID id, etc.) is
 * enforced structurally — not by prose.  Returns the validated receipt.
 *
 * @throws {ZodError} if any field fails validation (including an empty or
 *   invalid move — "cannot proceed" is never a valid receipt).
 */
export function appendDecision(store: DecisionReceiptStore, input: AppendDecisionInput): DecisionReceipt {
  const now = new Date().toISOString();
  const receipt = DecisionReceiptSchema.parse({
    id: randomUUID(),
    createdAt: now,
    gap: input.gap,
    move: input.move,
    statement: input.statement,
    reasons: input.reasons,
    workPlan: input.workPlan,
    evidence: input.evidence,
    status: "open",
    ...(input.nextCheckAt ? { nextCheckAt: input.nextCheckAt } : {})
  });

  store.decisions.push(receipt);
  return receipt;
}

/**
 * Return all open (unresolved) decision receipts, optionally filtered by move.
 *
 * @param store  The receipt store to query.
 * @param filter Optional — when `move` is set, only receipts with that move are returned.
 */
export function listOpenDecisions(
  store: DecisionReceiptStore,
  filter?: { move?: NeverStuckMove }
): DecisionReceipt[] {
  return store.decisions.filter((d) => {
    if (d.status !== "open") return false;
    if (filter?.move !== undefined && d.move !== filter.move) return false;
    return true;
  });
}
