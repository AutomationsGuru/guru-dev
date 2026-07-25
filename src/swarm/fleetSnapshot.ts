import { readdirSync } from "node:fs";

import { z } from "zod";

import type { SwarmManager } from "./manager.js";
import { SwarmTaskStateSchema, type SwarmTaskRecord, type SwarmTaskState } from "./schema.js";

/**
 * Fleet snapshot (IDEA-A4) — one read-only, operator-facing view of everything the
 * harness has in flight right now: swarm workers, the self-build task board, and open
 * coordination packets. The builder is PURE over its injected sources (swarm manager +
 * optional self-build state provider + optional packet directory reader); it never
 * mutates workers, files, or loop state, so surfacing it from a TUI command or a
 * read-only `fleet_status` tool cannot itself change the fleet. All fleet state is
 * in-memory / on-disk-now only — no durable cross-restart ledger is introduced here
 * (explicit exclusion B2).
 */

// ---------------------------------------------------------------------------
// Struct: workers[], self_build[], open_packets[], counts, updated_at (plan §1).
// ---------------------------------------------------------------------------

export const FleetWorkerEntrySchema = z
  .object({
    taskId: z.string(),
    label: z.string(),
    mode: z.string(),
    depth: z.number().int().nonnegative(),
    state: SwarmTaskStateSchema,
    toolCallCount: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional()
  })
  .strict();
export type FleetWorkerEntry = z.infer<typeof FleetWorkerEntrySchema>;

export const FleetSelfBuildEntrySchema = z
  .object({
    taskId: z.string(),
    title: z.string(),
    status: z.string(),
    priority: z.string().optional()
  })
  .strict();
export type FleetSelfBuildEntry = z.infer<typeof FleetSelfBuildEntrySchema>;

export const FleetOpenPacketEntrySchema = z
  .object({
    /** Packet filename relative to its directory (names only — never file contents). */
    name: z.string(),
    source: z.string()
  })
  .strict();
export type FleetOpenPacketEntry = z.infer<typeof FleetOpenPacketEntrySchema>;

export const FleetSnapshotCountsSchema = z
  .object({
    workersTotal: z.number().int().nonnegative(),
    workersActive: z.number().int().nonnegative(),
    workersTerminal: z.number().int().nonnegative(),
    selfBuildTotal: z.number().int().nonnegative(),
    selfBuildOpen: z.number().int().nonnegative(),
    selfBuildTerminal: z.number().int().nonnegative(),
    openPackets: z.number().int().nonnegative()
  })
  .strict();
export type FleetSnapshotCounts = z.infer<typeof FleetSnapshotCountsSchema>;

export const FleetSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    workers: z.array(FleetWorkerEntrySchema),
    selfBuild: z.array(FleetSelfBuildEntrySchema),
    openPackets: z.array(FleetOpenPacketEntrySchema),
    counts: FleetSnapshotCountsSchema,
    updatedAt: z.string().datetime()
  })
  .strict();
export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>;

/** Worker states where the worker can still act on the world. Everything else is settled. */
export const ACTIVE_WORKER_STATES: readonly SwarmTaskState[] = ["queued", "running"];
/** Self-build task statuses that still represent open work. Everything else is settled. */
export const ACTIVE_SELF_BUILD_STATUSES = ["ready", "in_progress", "blocked"] as const;

export function isActiveWorkerState(state: SwarmTaskState): boolean {
  return ACTIVE_WORKER_STATES.includes(state);
}

export function isActiveSelfBuildStatus(status: string): boolean {
  return (ACTIVE_SELF_BUILD_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Sources (plan §2): the swarm manager, a known self-build state if present, and
// known packet directories if present. Everything is optional except the manager —
// a bare boot reports an honest empty fleet rather than failing.
// ---------------------------------------------------------------------------

/** Minimal self-build board shape (satisfied by kernel SelfBuildState and tests). */
export interface FleetSelfBuildTaskLike {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
}

export interface FleetSnapshotSelfBuildSource {
  readonly tasks: readonly FleetSelfBuildTaskLike[];
}

export interface FleetSnapshotOptions {
  readonly manager: SwarmManager;
  /** Present when a self-build loop has produced a task board this session. */
  readonly selfBuild?: FleetSnapshotSelfBuildSource;
  /** Known coordination packet directories; missing/unreadable dirs are skipped honestly. */
  readonly packetDirs?: readonly string[];
  /** Injectable for deterministic tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

/** The filename suffixes that count as coordination packets. */
export const PACKET_FILE_SUFFIXES = [".md", ".json"] as const;

export function buildFleetSnapshot(options: FleetSnapshotOptions): FleetSnapshot {
  const now = options.now ?? (() => new Date());
  const workers = options.manager.list().map(toWorkerEntry);
  const selfBuild = (options.selfBuild?.tasks ?? []).map(toSelfBuildEntry);
  const openPackets = (options.packetDirs ?? []).flatMap(readPacketDir);

  return FleetSnapshotSchema.parse({
    schemaVersion: 1,
    workers,
    selfBuild,
    openPackets,
    counts: {
      workersTotal: workers.length,
      workersActive: workers.filter((worker) => isActiveWorkerState(worker.state)).length,
      workersTerminal: workers.filter((worker) => !isActiveWorkerState(worker.state)).length,
      selfBuildTotal: selfBuild.length,
      selfBuildOpen: selfBuild.filter((task) => isActiveSelfBuildStatus(task.status)).length,
      selfBuildTerminal: selfBuild.filter((task) => !isActiveSelfBuildStatus(task.status)).length,
      openPackets: openPackets.length
    },
    updatedAt: now().toISOString()
  });
}

function toWorkerEntry(record: SwarmTaskRecord): FleetWorkerEntry {
  return {
    taskId: record.id,
    label: record.label,
    mode: record.mode,
    depth: record.depth,
    state: record.state,
    toolCallCount: record.toolCallCount,
    startedAt: toIso(record.startedAt),
    ...(record.endedAt !== undefined ? { endedAt: toIso(record.endedAt) } : {})
  };
}

function toSelfBuildEntry(task: FleetSelfBuildTaskLike): FleetSelfBuildEntry {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    ...(task.priority !== undefined ? { priority: task.priority } : {})
  };
}

/** Swarm records stamp with toISOString already; normalize defensively for injected records. */
function toIso(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

/**
 * Read one packet directory as NAMES ONLY (secret hygiene §3.3: packet bodies may quote
 * anything; the snapshot lists which packets exist, never what they contain). A missing or
 * unreadable directory contributes nothing — an absent packet surface is not a failure.
 */
function readPacketDir(dir: string): FleetOpenPacketEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PACKET_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => ({ name, source: dir }));
}

/** Operator-facing one-line-per-section rendering (kept here so every surface agrees). */
export function renderFleetSnapshot(snapshot: FleetSnapshot): string {
  const lines: string[] = [
    `Fleet snapshot (${snapshot.updatedAt})`,
    `  workers: ${snapshot.counts.workersActive} active / ${snapshot.counts.workersTotal} total`,
    ...snapshot.workers.map((worker) => `    ${worker.taskId} [${worker.state}] ${worker.label} (${worker.mode}, depth ${worker.depth})`),
    `  self-build: ${snapshot.counts.selfBuildOpen} open / ${snapshot.counts.selfBuildTotal} total`,
    ...snapshot.selfBuild.map((task) => `    ${task.taskId} [${task.status}] ${task.title}`),
    `  open packets: ${snapshot.counts.openPackets}`,
    ...snapshot.openPackets.map((packet) => `    ${packet.name} (${packet.source})`)
  ];
  return lines.join("\n");
}

/** Serializable form for a read-only tool surface (already schema-clean; explicit for callers). */
export function serializeFleetSnapshot(snapshot: FleetSnapshot): string {
  return `${JSON.stringify(FleetSnapshotSchema.parse(snapshot), null, 2)}\n`;
}

/** Re-read a serialized snapshot (round-trip support for surfaces that cache it). */
export function parseFleetSnapshot(json: string): FleetSnapshot {
  return FleetSnapshotSchema.parse(JSON.parse(json));
}

/** Packet names in one directory for diagnostics (names only, never contents). */
export function listPacketDirNames(dir: string): readonly string[] {
  return readPacketDir(dir).map((packet) => packet.name);
}
