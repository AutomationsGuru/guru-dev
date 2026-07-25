import { makeGapRecord } from "../garage/gapRecords.js";
import type { GapRecord } from "../garage/manifest.js";

/**
 * Daytona sandbox ATTACH stub (IDEA-F232-DAYTONA-ATTACH-01).
 *
 * Daytona provides remote sandboxed execution environments. This module records
 * that capability as an explicit ATTACH parity gap without wiring a live Daytona
 * client into GuruHarness. A future F215 remote-sandbox adapter can compose this
 * stub while keeping the external dependency visible and replaceable.
 */

/** Stable provider identity for the Daytona sandbox attach surface. */
export const DAYTONA_SANDBOX_PROVIDER_ID = "daytona-sandbox";

const DAYTONA_NEED = "daytona remote sandbox execution";

/** Return the ATTACH parity gap for Daytona remote sandbox execution. */
export function parityGap(): GapRecord {
  return makeGapRecord(
    DAYTONA_NEED,
    "attach",
    "Daytona remote sandbox — ATTACH-tracked parity gap; F215 composes this stub when a live client is built.",
    new Date().toISOString()
  );
}

/** Return Daytona's provider identity and parity gap for catalog registration. */
export function daytonaSandboxAttachStub(): { readonly providerId: string; readonly gap: GapRecord } {
  return { providerId: DAYTONA_SANDBOX_PROVIDER_ID, gap: parityGap() };
}
