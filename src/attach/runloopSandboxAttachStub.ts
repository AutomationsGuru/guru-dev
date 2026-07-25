import { makeGapRecord } from "../garage/gapRecords.js";
import type { GapRecord } from "../garage/manifest.js";

/**
 * Runloop sandbox ATTACH stub (IDEA-F235-RUNLOOP-01).
 *
 * Runloop (https://runloop.ai) provides remote sandboxed execution
 * environments. This stub records Runloop as a known attach-class capability
 * with a parity gap — no live client ships here. A future lane (F215 remote
 * sandbox) composes this stub when a live Runloop integration is built.
 *
 * The stub carries:
 * - A stable {@link providerId} for routing / catalog registration.
 * - A {@link parityGap} record tracking the borrowed capability as an explicit
 *   ATTACH with a machine-evaluable trigger, so it is never a silent dependency.
 */

/** Stable provider identity for the Runloop sandbox attach surface. */
export const RUNLOOP_SANDBOX_PROVIDER_ID = "runloop-sandbox";

/** The capability need the parity gap tracks. */
const RUNLOOP_NEED = "runloop remote sandbox execution";

/**
 * The ATTACH parity-gap record for the Runloop sandbox.
 *
 * The returned record is idempotent — same need → same id. It carries
 * `move: "attach"` (this is a borrowed capability gated behind an explicit
 * wrapper, never a silent dependency) and a machine-evaluable trigger so the
 * boot ritual can detect when a native tool replaces it.
 */
export function parityGap(): GapRecord {
  return makeGapRecord(RUNLOOP_NEED, "attach", "Runloop remote sandbox — ATTACH-tracked parity gap; F215 composes this stub when a live client is built.", new Date().toISOString());
}

/**
 * Convenience: both the provider identity and its gap record in one call.
 * Useful for catalog registration / boot-ritual gap injection.
 */
export function runloopSandboxAttachStub(): { readonly providerId: string; readonly gap: GapRecord } {
  return { providerId: RUNLOOP_SANDBOX_PROVIDER_ID, gap: parityGap() };
}