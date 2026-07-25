import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Durable fleet ledger (IDEA-B2, R-CW-LEDGER, 2026-07-18) — an append-only JSONL
 * record of a multi-worker run, under the project's `.guru/fleet/` dir.
 *
 * One `fleet.jsonl` per ledger directory, one {@link FleetEvent} per line, ONLY
 * ever appended. This is the same lossless discipline as the session log: the
 * stream is never rewritten, so a crashed process leaves a replayable prefix and
 * `resume` (fleetResume.ts) can reconcile leases without guessing. A torn
 * trailing line (crash mid-append) is skipped on replay, never fatal.
 *
 * Hard-limit wiring (§3.3 no leaked secrets): every free-text field is run
 * through {@link scrubSecretValues} at the disk boundary, before it can persist.
 * The ledger deals in worker ids, roles, statuses, and artifact REFS — presence
 * and references, never secret values.
 */

export const FLEET_LEDGER_SCHEMA_VERSION = 1;

export const FLEET_LEDGER_FILE_NAME = "fleet.jsonl";

/** Why a worker stopped — drives resume()'s requeue-vs-escalate decision. */
export const FleetFailureClassSchema = z.enum(["transient", "task", "verifier", "needs_human"]);
export type FleetFailureClass = z.infer<typeof FleetFailureClassSchema>;

export const FleetWorkerStatusSchema = z.enum(["queued", "running", "done", "failed", "needs_human"]);
export type FleetWorkerStatus = z.infer<typeof FleetWorkerStatusSchema>;

const baseFields = {
  schemaVersion: z.number().int().positive(),
  /** Monotonic per ledger directory; survives restart (seeded from the prior tail). */
  seq: z.number().int().nonnegative(),
  ts: z.string().trim().min(1),
  runId: z.string().trim().min(1)
};

const workerFields = {
  workerId: z.string().trim().min(1)
};

/** A run began (or was resumed). `detail` is free text — scrubbed before persist. */
export const RunStartedEventSchema = z
  .object({ ...baseFields, kind: z.literal("run_started"), detail: z.string().optional() })
  .strict();

/** A worker was dispatched (attempt 1) or requeued (attempt > 1). */
export const WorkerSpawnedEventSchema = z
  .object({
    ...baseFields,
    ...workerFields,
    kind: z.literal("worker_spawned"),
    role: z.string().trim().min(1),
    attempt: z.number().int().positive().optional()
  })
  .strict();

/** Liveness signal from an in-flight worker. `tick` is the worker's own counter; the ledger's `seq` is separate. */
export const HeartbeatEventSchema = z
  .object({ ...baseFields, ...workerFields, kind: z.literal("heartbeat"), tick: z.number().int().nonnegative().optional() })
  .strict();

/** A worker produced a reference to an artifact (a diff, a note, a path). */
export const ArtifactEventSchema = z
  .object({ ...baseFields, ...workerFields, kind: z.literal("artifact"), artifactRef: z.string().trim().min(1) })
  .strict();

/** A worker reached a terminal state. */
export const WorkerFinishedEventSchema = z
  .object({
    ...baseFields,
    ...workerFields,
    kind: z.literal("worker_finished"),
    status: FleetWorkerStatusSchema,
    failureClass: FleetFailureClassSchema.optional(),
    detail: z.string().optional()
  })
  .strict();

/** A free-form operator/manager note (scrubbed before persist). */
export const NoteEventSchema = z.object({ ...baseFields, kind: z.literal("note"), detail: z.string() }).strict();

export const FleetEventSchema = z.discriminatedUnion("kind", [
  RunStartedEventSchema,
  WorkerSpawnedEventSchema,
  HeartbeatEventSchema,
  ArtifactEventSchema,
  WorkerFinishedEventSchema,
  NoteEventSchema
]);
export type FleetEvent = z.infer<typeof FleetEventSchema>;

/** The event input accepted by append() — everything but the stamped fields. */
export type FleetEventInput =
  | Omit<z.infer<typeof RunStartedEventSchema>, "schemaVersion" | "seq" | "ts">
  | Omit<z.infer<typeof WorkerSpawnedEventSchema>, "schemaVersion" | "seq" | "ts">
  | Omit<z.infer<typeof HeartbeatEventSchema>, "schemaVersion" | "seq" | "ts">
  | Omit<z.infer<typeof ArtifactEventSchema>, "schemaVersion" | "seq" | "ts">
  | Omit<z.infer<typeof WorkerFinishedEventSchema>, "schemaVersion" | "seq" | "ts">
  | Omit<z.infer<typeof NoteEventSchema>, "schemaVersion" | "seq" | "ts">;

/** A worker's lifecycle folded from the event stream (last-wins per field). */
export interface FleetWorkerRecord {
  readonly workerId: string;
  readonly role: string;
  status: FleetWorkerStatus;
  /** Total dispatch attempts (spawn + requeues). */
  attempts: number;
  heartbeats: number;
  readonly artifactRefs: string[];
  failureClass?: FleetFailureClass;
  /** Set on the latest heartbeat/finish; absent if the worker never reported. */
  lastSeenAt?: string;
}

export interface FleetLedgerOptions {
  /** Explicit directory override (tests). Wins over repoRoot. */
  readonly directory?: string;
  /** The session repo root; the ledger lands in `<repoRoot>/.guru/fleet`. */
  readonly repoRoot?: string;
  /** Clock override (tests). */
  readonly now?: () => Date;
}

export interface FleetLedger {
  readonly directory: string;
  /** Append one event (append-only; scrubbed; stamped). Returns the persisted event. */
  append(input: FleetEventInput): FleetEvent;
  /** Replay every valid event in order (torn trailing lines skipped). */
  readAll(): readonly FleetEvent[];
  /** Fold the stream into per-worker records for one run. */
  workers(runId: string): readonly FleetWorkerRecord[];
  /** The highest seq written so far (0 before the first append). */
  headSeq(): number;
}

/**
 * Resolve the ledger directory. An explicit `directory` wins (tests); otherwise
 * the ledger travels with the repo at `<repoRoot>/.guru/fleet`. A bare call with
 * neither falls back to a `.guru/fleet` under the CWD — the same project-local
 * default the rest of the space-scope state uses.
 */
export function resolveFleetLedgerDirectory(options: FleetLedgerOptions = {}): string {
  if (options.directory) {
    return options.directory;
  }
  if (options.repoRoot) {
    return join(options.repoRoot, ".guru", "fleet");
  }
  return join(process.cwd(), ".guru", "fleet");
}

/** Scrub every string field of an event payload (defense-in-depth at the boundary). */
function scrubPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = typeof value === "string" ? scrubSecretValues(value) : value;
  }
  return out;
}

export function createFleetLedger(options: FleetLedgerOptions = {}): FleetLedger {
  const directory = resolveFleetLedgerDirectory(options);
  const now = options.now ?? (() => new Date());
  const file = join(directory, FLEET_LEDGER_FILE_NAME);

  const ensureDir = (): void => {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  };

  const readAll = (): FleetEvent[] => {
    if (!existsSync(file)) {
      return [];
    }
    const events: FleetEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        // Torn trailing line from a crash mid-append: skip it; the valid prefix
        // still replays deterministically (degrade-never-destroy).
        continue;
      }
      const parsed = FleetEventSchema.safeParse(obj);
      if (parsed.success) {
        events.push(parsed.data);
      }
    }
    return events;
  };

  // Seed the monotonic counter from the durable tail so a restarted process
  // continues the sequence instead of restarting it (and colliding).
  let headSeqValue = 0;
  {
    const existing = readAll();
    if (existing.length > 0) {
      headSeqValue = existing[existing.length - 1]!.seq;
    }
  }

  const append = (input: FleetEventInput): FleetEvent => {
    ensureDir();
    headSeqValue += 1;
    const event = FleetEventSchema.parse(
      scrubPayload({
        ...input,
        schemaVersion: FLEET_LEDGER_SCHEMA_VERSION,
        seq: headSeqValue,
        ts: now().toISOString()
      })
    );
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  };

  const workers = (runId: string): FleetWorkerRecord[] => {
    const byId = new Map<string, FleetWorkerRecord>();
    for (const event of readAll()) {
      if (event.runId !== runId) {
        continue;
      }
      if (event.kind === "worker_spawned") {
        const existing = byId.get(event.workerId);
        if (existing) {
          // A re-dispatch (resume requeue): move to the NEW attempt and back to
          // queued. The heartbeat count resets for the new lease — a queued worker
          // with zero heartbeats on its current attempt is fresh, not orphaned.
          existing.attempts = event.attempt ?? existing.attempts + 1;
          existing.status = "queued";
          existing.heartbeats = 0;
          delete existing.failureClass;
          existing.lastSeenAt = event.ts;
        } else {
          byId.set(event.workerId, {
            workerId: event.workerId,
            role: event.role,
            status: "queued",
            attempts: event.attempt ?? 1,
            heartbeats: 0,
            artifactRefs: [],
            lastSeenAt: event.ts
          });
        }
      } else if (event.kind === "heartbeat") {
        const worker = byId.get(event.workerId);
        if (worker) {
          worker.heartbeats += 1;
          worker.lastSeenAt = event.ts;
          if (worker.status === "queued") {
            worker.status = "running";
          }
        }
      } else if (event.kind === "artifact") {
        byId.get(event.workerId)?.artifactRefs.push(event.artifactRef);
      } else if (event.kind === "worker_finished") {
        const worker = byId.get(event.workerId);
        if (worker) {
          worker.status = event.status;
          worker.lastSeenAt = event.ts;
          if (event.failureClass) {
            worker.failureClass = event.failureClass;
          } else {
            delete worker.failureClass;
          }
        }
      }
    }
    return [...byId.values()];
  };

  return {
    directory,
    append,
    readAll,
    workers,
    headSeq: () => headSeqValue
  };
}
