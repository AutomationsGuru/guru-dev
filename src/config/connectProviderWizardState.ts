/**
 * Connect Provider Wizard State
 *
 * Pure state machine for listing providers and recording which are configured.
 * Keys are never stored in this module — provider IDs are identifiers only.
 *
 * States: idle → selecting → done (auto-transitions when all providers configured)
 *
 * @module connectProviderWizardState
 * @work-id IDEA-F201-CONNECT-WIZ-01
 */

/** Provider wizard phases. */
export type WizardPhase = "idle" | "selecting" | "done";

/** Immutable wizard state — each transition returns a new object. */
export interface ConnectProviderWizardState {
  readonly phase: WizardPhase;
  /** Provider IDs that the operator still needs to configure. */
  readonly pending: ReadonlySet<string>;
  /** Provider IDs the operator has already configured this session. */
  readonly configured: ReadonlySet<string>;
}

/** Create a fresh wizard in idle phase with no providers. */
export function createConnectProviderWizard(): ConnectProviderWizardState {
  return { phase: "idle", pending: new Set(), configured: new Set() };
}

/**
 * Begin selecting: supply the list of provider IDs to configure.
 * Only transitions from idle; a no-op from selecting or done.
 */
export function startSelecting(
  state: ConnectProviderWizardState,
  providerIds: ReadonlyArray<string>
): ConnectProviderWizardState {
  if (state.phase !== "idle") return state;
  return { phase: "selecting", pending: new Set(providerIds), configured: new Set() };
}

/**
 * Record a provider as configured.
 * No-op if the wizard is not in selecting phase, or if the provider
 * is not in the pending set (unknown or already configured).
 *
 * When the last pending provider is configured, auto-transitions to done.
 */
export function markConfigured(
  state: ConnectProviderWizardState,
  providerId: string
): ConnectProviderWizardState {
  if (state.phase !== "selecting" || !state.pending.has(providerId)) return state;

  const pending = new Set(state.pending);
  pending.delete(providerId);
  const configured = new Set(state.configured);
  configured.add(providerId);

  const phase: WizardPhase = pending.size === 0 ? "done" : "selecting";

  return { phase, pending, configured };
}
