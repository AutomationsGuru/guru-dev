/**
 * Mixture-of-agents aggregate (IDEA-F517-MOA-01) — a PURE merge step over
 * parallel expert outputs, in the spirit of the swarm contract
 * (docs/decisions/2026-07-04-swarm-contract.md): bounded inputs, honest
 * failure, no hidden state. The aggregator receives EVERY expert output, in
 * input order, on a frozen defensive copy; empty input fires a structured
 * error rather than a fake success. Synchronous aggregators only — this is a
 * pure function with no I/O and no runtime dependencies.
 */

export interface MixtureOfAgentsExpertOutput {
  readonly expertId: string;
  readonly text: string;
  /** Opaque per-expert metadata (route, confidence, ...) carried through untouched. */
  readonly metadata?: unknown;
}

/**
 * A pure merge function: receives every expert output (readonly, frozen, in
 * input order) and returns the merged result. Generic over the output shape so
 * callers can aggregate richer expert records than the default text form.
 */
export type MixtureOfAgentsAggregator<I, O> = (outputs: readonly I[]) => O;

/** Structured error when aggregate is asked to merge zero experts. */
export class MixtureOfAgentsNoExpertsError extends Error {
  readonly code = "moa_no_experts";
  constructor() {
    super("Mixture-of-agents aggregate requires at least one expert output — refusing to fake a merge over nothing.");
    this.name = "MixtureOfAgentsNoExpertsError";
  }
}

/**
 * Merge parallel expert outputs through `aggregator`. Guarantees: every expert
 * is included exactly once, in input order; the input array is never mutated
 * (the aggregator sees a frozen copy); empty input throws
 * `MixtureOfAgentsNoExpertsError`; aggregator errors propagate unchanged.
 */
export function aggregateMixtureOfAgents<I, O>(outputs: readonly I[], aggregator: MixtureOfAgentsAggregator<I, O>): O {
  if (outputs.length === 0) {
    throw new MixtureOfAgentsNoExpertsError();
  }
  // Defensive copy + freeze: the aggregator cannot mutate the caller's array,
  // and what it sees is exactly the input — every expert, in order.
  return aggregator(Object.freeze([...outputs]));
}
