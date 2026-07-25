import { randomUUID } from "node:crypto";

import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from "../providers/schemas.js";
import type { ChatTurnMessage } from "../model/directChat.js";
import type { AgentSessionStats } from "./agentSession.js";
import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Workspace mobility snapshot (IDEA-F471-MOBILE-01, R-PRO-MOBILE).
 *
 * Snapshot workspace session state to a serializable bag; restore creates a NEW
 * session record with the prior fields. The bag is the mobility artifact: it is
 * meant to cross machines (move a workspace between hosts), so it is plain JSON
 * and every exported `content` string is scrubbed for secret-shaped values at
 * the export boundary — presence-over-value, never a leaked credential in a
 * mobility packet (Vision §3.3).
 *
 * SCOPE: pure snapshot/import logic only. This module never executes anything,
 * never touches worktrees, sessions, branches, or live files, and never moves
 * durable session state on disk. It produces and consumes an in-memory bag; the
 * caller owns persistence and the live session record.
 */

/** Bumped only on a breaking change to the bag shape. */
export const WORKSPACE_MOBILITY_SNAPSHOT_VERSION = 1;

/** The restorable fields a caller assembles for export (or reads off a live session). */
export interface WorkspaceMobilityExportInput {
  /** Conversation history to carry across — content is scrubbed on export. */
  readonly history: readonly ChatTurnMessage[];
  /** The active provider route the snapshot continues on. */
  readonly route: ProviderRouteDescriptor;
  /** Per-call model id override, if any (null/omitted = none). */
  readonly modelIdOverride?: string | null;
  /** Cumulative usage stats to preserve across the move. */
  readonly usage?: AgentSessionStats;
}

/**
 * The serializable mobility bag. Plain JSON; round-trips through
 * `JSON.parse(JSON.stringify(...))`. `route` is validated on import so a
 * foreign/tampered bag cannot seed an invalid route descriptor.
 */
export interface WorkspaceMobilityStateBag {
  readonly schemaVersion: typeof WORKSPACE_MOBILITY_SNAPSHOT_VERSION;
  /** ISO timestamp of the export (provenance; `now`-injectable for tests). */
  readonly exportedAt: string;
  readonly history: readonly ChatTurnMessage[];
  readonly route: ProviderRouteDescriptor;
  readonly modelIdOverride: string | null;
  readonly usage?: AgentSessionStats;
}

export interface WorkspaceMobilityExportOptions {
  /** Injectable clock (deterministic tests); defaults to `new Date().toISOString()`. */
  readonly now?: () => Date;
}

export interface WorkspaceMobilityImportResult {
  /** A freshly generated session id — always new, never the source id. */
  readonly sessionId: string;
  readonly history: readonly ChatTurnMessage[];
  readonly route: ProviderRouteDescriptor;
  readonly modelIdOverride: string | null;
  readonly usage?: AgentSessionStats;
  /** Provenance: the schema version the bag was exported with. */
  readonly importedFromSchemaVersion: typeof WORKSPACE_MOBILITY_SNAPSHOT_VERSION;
  /** Provenance: the export timestamp carried on the bag. */
  readonly exportedAt: string;
}

export interface WorkspaceMobilityImportOptions {
  /** New session id factory (tests). Defaults to crypto.randomUUID. */
  readonly newId?: () => string;
}

/**
 * Snapshot workspace session state into a serializable, secret-scrubbed bag.
 * The input is read once and deep-copied; the caller's arrays/objects are not
 * mutated. Every `content` string is scrubbed for secret-shaped values before
 * it leaves the live session — a mobility packet may cross hosts.
 */
export function exportWorkspaceMobilitySnapshot(
  input: WorkspaceMobilityExportInput,
  options: WorkspaceMobilityExportOptions = {}
): WorkspaceMobilityStateBag {
  const now = options.now ?? (() => new Date());
  return {
    schemaVersion: WORKSPACE_MOBILITY_SNAPSHOT_VERSION,
    exportedAt: now().toISOString(),
    // Deep-copy + scrub so the bag is independent of the live session and
    // carries no secret-shaped value across the mobility boundary.
    history: input.history.map((message) => ({
      role: message.role,
      content: scrubSecretValues(message.content)
    })),
    route: input.route,
    modelIdOverride: input.modelIdOverride ?? null,
    ...(input.usage !== undefined ? { usage: input.usage } : {})
  };
}

/**
 * Restore a mobility bag onto a NEW session id with the prior fields preserved.
 * Pure reconstruction: the input bag is validated, not executed or mutated.
 *
 * Validation (defensive — the bag may come from another host):
 *  - `schemaVersion` must be present (rejects foreign/tampered payloads early).
 *  - `route` is re-parsed through `ProviderRouteDescriptorSchema` so an invalid
 *    descriptor cannot seed the restored session.
 */
export function importWorkspaceMobilitySnapshot(
  bag: WorkspaceMobilityStateBag,
  options: WorkspaceMobilityImportOptions = {}
): WorkspaceMobilityImportResult {
  if (bag.schemaVersion === undefined || bag.schemaVersion === null) {
    throw new Error("WorkspaceMobilitySnapshot: missing schemaVersion — refusing to import a foreign or tampered bag.");
  }
  if (bag.schemaVersion !== WORKSPACE_MOBILITY_SNAPSHOT_VERSION) {
    throw new Error(`WorkspaceMobilitySnapshot: unsupported schemaVersion ${String(bag.schemaVersion)} (expected ${WORKSPACE_MOBILITY_SNAPSHOT_VERSION}).`);
  }
  const route = ProviderRouteDescriptorSchema.parse(bag.route);
  const mkId = options.newId ?? randomUUID;
  const sessionId = mkId();
  return {
    sessionId,
    // Copy history so the restored view is independent of the input bag.
    history: Array.from(bag.history),
    route,
    modelIdOverride: bag.modelIdOverride ?? null,
    ...(bag.usage !== undefined ? { usage: bag.usage } : {}),
    importedFromSchemaVersion: bag.schemaVersion,
    exportedAt: bag.exportedAt
  };
}
