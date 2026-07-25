/**
 * Pre-compact gate types.
 *
 * The gate answers a single question immediately before the summarizer runs:
 * may this compaction proceed? It is intentionally synchronous and bounded: no
 * async work, no locks, no waits. Callers that need async preparation should do
 * so before invoking compaction and surface the result as a flag.
 */

/** A single reason compact was blocked. Human-facing, never a structural promise. */
export interface PreCompactBlockReason {
  /** Stable machine-readable category. */
  readonly category: string;
  /** Human-readable explanation (no secret values, no raw state dumps). */
  readonly message: string;
}

/** Result of consulting the pre-compact gate. */
export type PreCompactDecision =
  | { readonly action: "allow"; readonly blockReason?: never }
  | { readonly action: "block"; readonly blockReason: PreCompactBlockReason };

/** A synchronous, pure function that decides whether compact may run now. */
export type PreCompactHook = (context: PreCompactContext) => PreCompactDecision;

/** Optional synchronous hooks consulted before each compaction attempt. */
export interface PreCompactConfig {
  readonly hooks?: readonly PreCompactHook[];
}

/** Context visible to the pre-compact gate. Read-only, bounded, no full transcript. */
export interface PreCompactContext {
  /** Estimated tokens in the region that would be folded. */
  readonly tokensBefore: number;
  /** Stable id of the first entry that would survive compact. */
  readonly firstKeptEntryId: string;
  /** Why compaction was triggered. */
  readonly reason: "manual" | "threshold";
  /** Iteration count of compacts already applied (0 = none yet). */
  readonly compactCount: number;
}

/** Receipt emitted by the gate, durable enough to audit a block/allow decision. */
export interface PreCompactReceipt {
  readonly decision: PreCompactDecision;
  /** RFC3339 timestamp from the caller's clock (passed in, never read here). */
  readonly checkedAt: string;
  /** Hooks that contributed to a block (empty when allowed). */
  readonly blockingHooks: readonly string[];
}
