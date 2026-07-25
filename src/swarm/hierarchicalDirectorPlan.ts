import { randomUUID } from "node:crypto";

import { z } from "zod";

/**
 * Hierarchical director plan (IDEA-F522-HIER-01): a director emits task
 * assignments, workers return results, and a reviewer decides whether the
 * loop runs again — but never past `maxLoops`. Mirrors the swarm contract
 * (docs/decisions/2026-07-04-swarm-contract.md): injected worker, hard-capped
 * config, structured budget error, no fake success. The worker is INJECTED
 * late (the live session binds it once a route is connected); with no worker
 * bound, assignments fail honestly with `state: "failed"`.
 */

/** Hard-capped config so a reviewer that always wants more cannot loop forever. */
export const HierarchicalDirectorPlanConfigSchema = z
  .object({
    /** Max review loops. Hard-capped so a reviewer that always wants more cannot loop forever. */
    maxLoops: z.number().int().positive().max(8).default(3),
    /** Max assignments the director will dispatch in a single review loop. */
    maxAssignmentsPerLoop: z.number().int().positive().max(16).default(4),
    /** Per-assignment completion token cap (composite budget). */
    assignmentTokenBudget: z.number().int().positive().max(200_000).default(8_192),
    assignmentTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
    /** Token cap for the reviewer turn. */
    reviewTokenBudget: z.number().int().positive().max(200_000).default(8_192)
  })
  .strict();

export type HierarchicalDirectorPlanConfig = z.infer<typeof HierarchicalDirectorPlanConfigSchema>;

/** Structured error when a review loop would exceed its per-loop assignment budget. */
export class DirectorLoopBudgetExceededError extends Error {
  readonly code = "director_loop_exceeded";
  constructor(readonly detail: string) {
    super(`Hierarchical director plan loop budget exceeded — ${detail}`);
    this.name = "DirectorLoopBudgetExceededError";
  }
}

export const DirectorAssignmentStateSchema = z.enum(["assigned", "running", "done", "failed"]);
export type DirectorAssignmentState = z.infer<typeof DirectorAssignmentStateSchema>;

/** A single director assignment and its lifecycle state. */
export interface DirectorAssignment {
  readonly id: string;
  readonly prompt: string;
  /** Which review loop (0-indexed) spawned this assignment. */
  readonly loop: number;
  state: DirectorAssignmentState;
  resultText?: string;
  error?: string;
  readonly startedAt: string;
  endedAt?: string;
}

/** Result returned by an injected worker. */
export interface DirectorWorkerResult {
  readonly text: string;
  /** Echo of the loop the worker ran in. */
  readonly loop: number;
}

/** Injected worker — the live session binds it once a route is connected. */
export type DirectorWorker = (assignment: DirectorAssignment) => Promise<DirectorWorkerResult>;

/** Reviewer verdict: accept the gathered results, or hand back more prompts. */
export interface DirectorReviewResult {
  /** True when the reviewer accepts the gathered results and ends the loop. */
  readonly accepted: boolean;
  /** Prompts the director should dispatch in the next loop (ignored if accepted). */
  readonly nextAssignments: readonly string[];
}

/** Reviewer — decides whether the loop runs again. */
export type DirectorReviewer = (
  collected: readonly DirectorAssignment[],
  loop: number
) => Promise<DirectorReviewResult>;

/** Outcome of `runReviewLoop`. */
export interface DirectorLoopSummary {
  readonly loopsRun: number;
  /** True when the loop stopped because it hit maxLoops, not because the reviewer accepted. */
  readonly budgetExceeded: boolean;
  readonly assignments: readonly DirectorAssignment[];
}

/** Bounded director plan over an injected worker and reviewer. */
export interface HierarchicalDirectorPlan {
  readonly config: HierarchicalDirectorPlanConfig;
  setWorker(worker: DirectorWorker | null): void;
  /** Enqueue an assignment at `loop` (default 0). Returns the record immediately. */
  assign(prompt: string, loop?: number): DirectorAssignment;
  /** Gather assignments; scoped to `loop` when provided. */
  collect(loop?: number): readonly DirectorAssignment[];
  /** Number of review loops executed so far. */
  loopCount(): number;
  /** Test/support: resolves when every queued/in-flight assignment settles. */
  drain(): Promise<void>;
  /**
   * Drive the director: dispatch `initialPrompts` (loop 0), drain, then ask the reviewer.
   * While not accepted and loops remain, dispatch the reviewer's nextAssignments at the next
   * loop and review again. Stops at maxLoops (budgetExceeded=true) or on accept (false).
   * Throws DirectorLoopBudgetExceededError when a loop's assignment count exceeds maxAssignmentsPerLoop.
   */
  runReviewLoop(initialPrompts: readonly string[], reviewer: DirectorReviewer): Promise<DirectorLoopSummary>;
}

export function createHierarchicalDirectorPlan(
  rawConfig: Partial<HierarchicalDirectorPlanConfig> = {}
): HierarchicalDirectorPlan {
  const config = HierarchicalDirectorPlanConfigSchema.parse(rawConfig);
  const assignments = new Map<string, DirectorAssignment>();
  const inFlight = new Set<Promise<void>>();
  let worker: DirectorWorker | null = null;
  let loopsStarted = 0;

  // Invoke the worker for a record. The worker is called synchronously inside
  // `assign` (so an injected worker that captures the request synchronously —
  // e.g. a deferred-resolution test helper — observes it before the caller
  // runs its next line), but the record is left in its initial "assigned"
  // state until the worker settles. This mirrors how spawn returns before the
  // runner observes the task, and keeps `drain()` honest: the worker promise
  // is tracked in `inFlight` immediately.
  const pump = (record: DirectorAssignment): void => {
    const activeWorker = worker;
    if (!activeWorker) {
      record.state = "failed";
      record.error = "No worker connected — the director plan needs a live worker.";
      record.endedAt = new Date().toISOString();
      return;
    }
    const work = activeWorker(record)
      .then((result) => {
        record.state = "done";
        record.resultText = result.text;
      })
      .catch((error: unknown) => {
        record.state = "failed";
        record.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      })
      .finally(() => {
        record.endedAt = new Date().toISOString();
        inFlight.delete(work);
      });
    inFlight.add(work);
  };

  return {
    config,
    setWorker(next) {
      worker = next;
    },
    assign(prompt, loop = 0) {
      const record: DirectorAssignment = {
        id: randomUUID().slice(0, 8),
        prompt,
        loop,
        state: "assigned",
        startedAt: new Date().toISOString()
      };
      assignments.set(record.id, record);
      pump(record);
      return record;
    },
    collect(loop) {
      const all = [...assignments.values()];
      return loop === undefined ? all : all.filter((a) => a.loop === loop);
    },
    loopCount() {
      return loopsStarted;
    },
    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    async runReviewLoop(initialPrompts, reviewer) {
      if (initialPrompts.length > config.maxAssignmentsPerLoop) {
        throw new DirectorLoopBudgetExceededError(
          `initial prompts (${initialPrompts.length}) exceed maxAssignmentsPerLoop (${config.maxAssignmentsPerLoop})`
        );
      }
      let prompts: readonly string[] = initialPrompts;
      for (let loop = 0; loop < config.maxLoops; loop += 1) {
        loopsStarted = loop + 1;
        for (const prompt of prompts) {
          this.assign(prompt, loop);
        }
        await this.drain();
        const collected = this.collect(loop);
        const review = await reviewer(collected, loop);
        if (review.accepted) {
          return {
            loopsRun: loop + 1,
            budgetExceeded: false,
            assignments: this.collect()
          };
        }
        if (review.nextAssignments.length === 0) {
          // Reviewer has nothing more to assign — stop without flagging budget.
          return {
            loopsRun: loop + 1,
            budgetExceeded: false,
            assignments: this.collect()
          };
        }
        if (review.nextAssignments.length > config.maxAssignmentsPerLoop) {
          throw new DirectorLoopBudgetExceededError(
            `reviewer nextAssignments (${review.nextAssignments.length}) at loop ${loop} exceed maxAssignmentsPerLoop (${config.maxAssignmentsPerLoop})`
          );
        }
        if (loop + 1 >= config.maxLoops) {
          return {
            loopsRun: loop + 1,
            budgetExceeded: true,
            assignments: this.collect()
          };
        }
        prompts = review.nextAssignments;
      }
      // Unreachable: the loop above returns on every path within maxLoops.
      return {
        loopsRun: loopsStarted,
        budgetExceeded: true,
        assignments: this.collect()
      };
    }
  };
}
