import { z } from "zod";

/**
 * Swarm v1 (Phase F, 2026-07-04) — the bounded contract per
 * docs/decisions/2026-07-04-swarm-contract.md. Ceilings are configuration,
 * HARD-CAPPED in the schema so a bad config cannot unleash unbounded fan-out.
 */

export const SwarmConfigSchema = z
  .object({
    /** Concurrent workers on this machine. ultraSwarm raises the effective cap. */
    maxConcurrentWorkers: z.number().int().positive().max(16).default(3),
    /** Per-worker tool budget (iterations) — deliberately ≤ the parent's 24. */
    workerToolCallBudget: z.number().int().positive().max(24).default(8),
    /** Per-worker completion token cap (bounds each worker response; composite budget with iterations). */
    workerTokenBudget: z.number().int().positive().max(200_000).default(8_192),
    workerTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
    /** The crank (directive #5): lifts concurrency to the schema max for big iron. */
    ultraSwarm: z.boolean().default(false),
    /** Runaway backstop: total tasks per session. */
    maxTasksPerSession: z.number().int().positive().max(256).default(64),
    /** Recursion depth ceiling (§9): a spawn beyond this fires a structured error. */
    maxSpawnDepth: z.number().int().positive().max(8).default(3)
  })
  .strict();

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

/** Structured error when a spawn would exceed the recursion-depth ceiling (§9 / §17 S5). */
export class SwarmDepthExceededError extends Error {
  readonly code = "swarm_depth_exceeded";
  constructor(
    readonly depth: number,
    readonly limit: number
  ) {
    super(`Swarm recursion depth ${depth} exceeds the limit of ${limit} — a worker cannot spawn this deep.`);
    this.name = "SwarmDepthExceededError";
  }
}

export const SwarmWorkerModeSchema = z.enum(["read-only", "all"]);
export type SwarmWorkerMode = z.infer<typeof SwarmWorkerModeSchema>;

export const SwarmTaskStateSchema = z.enum(["queued", "running", "done", "failed", "killed"]);
export type SwarmTaskState = z.infer<typeof SwarmTaskStateSchema>;

export interface SwarmTaskRecord {
  readonly id: string;
  readonly label: string;
  readonly promptPreview: string;
  readonly mode: SwarmWorkerMode;
  /** Recursion depth of this spawn (0 = spawned by the parent session). */
  readonly depth: number;
  state: SwarmTaskState;
  resultText?: string;
  error?: string;
  toolCallCount: number;
  /** True when the worker hit its tool-call budget — its output may be partial. */
  budgetExceeded?: boolean;
  readonly startedAt: string;
  endedAt?: string;
}

export const SpawnAgentInputSchema = z
  .object({
    prompt: z.string().trim().min(1),
    /** read-only scouts by default: the worker physically cannot mutate. */
    mode: SwarmWorkerModeSchema.default("read-only"),
    label: z.string().trim().min(1).max(60).optional()
  })
  .strict();

export const SpawnAgentResultSchema = z
  .object({
    taskId: z.string(),
    state: SwarmTaskStateSchema,
    summary: z.string()
  })
  .strict();

export const TaskOutputInputSchema = z.object({ taskId: z.string().trim().min(1) }).strict();

export const TaskOutputResultSchema = z
  .object({
    found: z.boolean(),
    state: SwarmTaskStateSchema.optional(),
    label: z.string().optional(),
    resultText: z.string().optional(),
    error: z.string().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    /** The worker hit its tool-call budget — treat resultText as partial. */
    budgetExceeded: z.boolean().optional(),
    summary: z.string()
  })
  .strict();

export const KillTaskInputSchema = z.object({ taskId: z.string().trim().min(1) }).strict();
