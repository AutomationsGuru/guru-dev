import { randomUUID } from "node:crypto";

import { SwarmConfigSchema, SwarmDepthExceededError, type SwarmConfig, type SwarmTaskRecord, type SwarmWorkerMode } from "./schema.js";

/**
 * Swarm manager — a bounded scheduler over the agent-turn unit (contract:
 * docs/decisions/2026-07-04-swarm-contract.md). The runner is INJECTED late
 * (the live session binds it once a route is connected) and each call receives
 * the worker's mode so approval policy is enforced at execution time, never
 * frozen at spawn time. The manager itself has no privileges: no runner bound
 * means spawns fail honestly.
 */

export interface SwarmWorkerRequest {
  readonly prompt: string;
  readonly mode: SwarmWorkerMode;
  readonly toolCallBudget: number;
  /** Per-worker completion token cap. */
  readonly tokenBudget: number;
  readonly timeoutMs: number;
  /** Recursion depth of this worker (0 = spawned by the parent session). */
  readonly depth: number;
  /**
   * The parent's mandate SNAPSHOT at spawn time (opaque to the manager). Sibling
   * isolation (§9): a mandate change after spawn does not reach an in-flight worker.
   */
  readonly mandateSnapshot?: unknown;
}

export interface SwarmWorkerResult {
  readonly text: string;
  readonly toolCallCount: number;
  /** The worker consumed its whole tool-call budget — its output may be partial. */
  readonly budgetExceeded?: boolean;
}

export type SwarmTurnRunner = (request: SwarmWorkerRequest) => Promise<SwarmWorkerResult>;

/** Captures the parent's mandate at spawn time (opaque snapshot). Set by the live session. */
export type SwarmSnapshotProvider = () => unknown;

export interface SwarmSpawnOptions {
  /** Recursion depth (default 0). A worker spawning a worker passes its own depth + 1. */
  readonly depth?: number;
}

export interface SwarmManager {
  readonly config: SwarmConfig;
  setRunner(runner: SwarmTurnRunner | null): void;
  /** Provide the mandate-snapshot capture used at spawn time (sibling isolation). */
  setSnapshotProvider(provider: SwarmSnapshotProvider | null): void;
  spawn(prompt: string, mode: SwarmWorkerMode, label?: string, options?: SwarmSpawnOptions): SwarmTaskRecord;
  get(taskId: string): SwarmTaskRecord | undefined;
  kill(taskId: string): SwarmTaskRecord | undefined;
  list(): readonly SwarmTaskRecord[];
  /** Effective concurrency after the ultraSwarm crank. */
  effectiveConcurrency(): number;
  /** Test/support: resolves when every non-queued task settles. */
  drain(): Promise<void>;
}

export function createSwarmManager(rawConfig: Partial<SwarmConfig> = {}): SwarmManager {
  const config = SwarmConfigSchema.parse(rawConfig);
  const tasks = new Map<string, SwarmTaskRecord>();
  const queue: Array<{ record: SwarmTaskRecord; prompt: string; snapshot: unknown }> = [];
  const inFlight = new Set<Promise<void>>();
  let runner: SwarmTurnRunner | null = null;
  let snapshotProvider: SwarmSnapshotProvider | null = null;
  let running = 0;
  let spawnedTotal = 0;

  const effectiveConcurrency = (): number => (config.ultraSwarm ? 16 : config.maxConcurrentWorkers);

  const pump = (): void => {
    while (running < effectiveConcurrency() && queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      const { record, prompt, snapshot } = next;
      if (record.state === "killed") {
        continue; // killed while queued — never starts
      }
      const activeRunner = runner;
      if (!activeRunner) {
        record.state = "failed";
        record.error = "No model connected — the swarm needs a live route.";
        record.endedAt = new Date().toISOString();
        continue;
      }
      running += 1;
      record.state = "running";
      const work = activeRunner({
        prompt,
        mode: record.mode,
        toolCallBudget: config.workerToolCallBudget,
        tokenBudget: config.workerTokenBudget,
        timeoutMs: config.workerTimeoutMs,
        depth: record.depth,
        // The mandate snapshot captured at SPAWN — sibling isolation (§9).
        ...(snapshot !== undefined ? { mandateSnapshot: snapshot } : {})
      })
        .then((result) => {
          record.toolCallCount = result.toolCallCount;
          if (result.budgetExceeded) {
            record.budgetExceeded = true;
          }
          if (record.state !== "killed") {
            record.state = "done";
            record.resultText = result.text;
          }
          // killed-while-running: mark-and-detach — the result is discarded.
        })
        .catch((error: unknown) => {
          if (record.state !== "killed") {
            record.state = "failed";
            record.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
          }
        })
        .finally(() => {
          record.endedAt = new Date().toISOString();
          running -= 1;
          inFlight.delete(work);
          pump();
        });
      inFlight.add(work);
    }
  };

  return {
    config,
    setRunner(next) {
      runner = next;
      pump();
    },
    setSnapshotProvider(provider) {
      snapshotProvider = provider;
    },
    spawn(prompt, mode, label, options) {
      const depth = options?.depth ?? 0;
      // Recursion-depth ceiling (§9 / §17 S5): a structured error, never a silent stop.
      if (depth > config.maxSpawnDepth) {
        throw new SwarmDepthExceededError(depth, config.maxSpawnDepth);
      }
      if (spawnedTotal >= config.maxTasksPerSession) {
        throw new Error(`Swarm session task cap reached (${config.maxTasksPerSession}).`);
      }
      spawnedTotal += 1;
      const record: SwarmTaskRecord = {
        id: randomUUID().slice(0, 8),
        label: label ?? prompt.replace(/\s+/gu, " ").slice(0, 40),
        promptPreview: prompt.replace(/\s+/gu, " ").slice(0, 120),
        mode,
        depth,
        state: "queued",
        toolCallCount: 0,
        startedAt: new Date().toISOString()
      };
      tasks.set(record.id, record);
      // Snapshot the mandate NOW (at spawn), not at execution time — sibling isolation.
      const snapshot = snapshotProvider ? snapshotProvider() : undefined;
      queue.push({ record, prompt, snapshot });
      pump();
      return record;
    },
    get(taskId) {
      return tasks.get(taskId);
    },
    kill(taskId) {
      const record = tasks.get(taskId);
      if (record && (record.state === "queued" || record.state === "running")) {
        record.state = "killed";
        record.endedAt = new Date().toISOString();
      }
      return record;
    },
    list() {
      return [...tasks.values()];
    },
    effectiveConcurrency,
    async drain() {
      while (inFlight.size > 0 || queue.length > 0) {
        await Promise.allSettled([...inFlight]);
        if (queue.length > 0 && runner === null) {
          break; // queued forever without a runner — don't spin
        }
        if (queue.length > 0) {
          pump();
        }
        if (inFlight.size === 0 && queue.length === 0) {
          break;
        }
        if (inFlight.size === 0 && queue.length > 0) {
          break; // nothing can make progress
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Process-shared manager: the extension host registers the tools and the live
// session binds the runner — both must see the SAME manager. First configure
// wins (per-process); tests use createSwarmManager for isolation.
// ---------------------------------------------------------------------------

let sharedManager: SwarmManager | undefined;

export function getSharedSwarmManager(config: Partial<SwarmConfig> = {}): SwarmManager {
  if (!sharedManager) {
    sharedManager = createSwarmManager(config);
  }
  return sharedManager;
}

/** Test-only: reset the process-shared manager. */
export function resetSharedSwarmManagerForTests(): void {
  sharedManager = undefined;
}
