import { z } from "zod";

/**
 * Orchestrator DAG runner (IDEA-F267-DAG-ORCH-01).
 *
 * A small, owned runtime that turns a DAG-shaped plan into a bounded
 * parallel execution. The runner is intentionally narrow:
 *
 *  - Nodes form a DAG. The schema rejects duplicate ids, unknown deps,
 *    and self-edges; a separate cycle check rejects any cycle the static
 *    schema would otherwise permit (e.g. A -> B -> A across two nodes).
 *  - Ready nodes (all upstream deps `done`) fan out in parallel up to a
 *    configured concurrency ceiling.
 *  - The fan-in `continueHook` fires once per wave AFTER every node in
 *    the current wave has settled. Its return value is the next plan or
 *    null to stop. A non-null continuation merges into the same
 *    scheduler; the hook does NOT block individual node completion.
 *  - Failure is structured: a worker exception is captured into the
 *    node's result with state `failed`. The runner does NOT throw —
 *    failure is data. The caller decides whether to suppress downstream
 *    nodes for a failed dep via `skipOnFailure`.
 *
 * The worker closure is supplied by the caller. The runner does NOT
 * import a provider, model, or framework — capability is composed
 * through the caller's worker, not silently absorbed into core.
 *
 * Out of scope (per the plan explicit exclusions):
 *  - No multi-tenant scheduler, no telemetry, no default-on audit stream.
 *  - No HITL gating hidden in the runner — that lives in the hook the
 *    caller supplies.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DagNodeStateSchema = z.enum(["pending", "running", "done", "failed", "skipped"]);
export type DagNodeState = z.infer<typeof DagNodeStateSchema>;

export const DagNodeSchema = z
  .object({
    id: z.string().trim().min(1),
    /** IDs of upstream nodes that must be `done` before this node may run. */
    dependsOn: z.array(z.string().trim().min(1)).default([]),
    /** Optional human title — surfaces in the report and any worker logs. */
    title: z.string().trim().min(1).optional(),
    /** Opaque payload forwarded to the worker for this node. */
    input: z.unknown().optional()
  })
  .strict();
export type DagNode = z.infer<typeof DagNodeSchema>;

export const DagPlanSchema = z
  .object({
    objective: z.string().trim().min(1),
    /** All nodes in the DAG. IDs must be unique. */
    nodes: z.array(DagNodeSchema).min(1)
  })
  .strict()
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    const known = new Set<string>();
    for (const node of plan.nodes) {
      if (seen.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes"],
          message: `Duplicate node id: ${node.id}`
        });
      }
      seen.add(node.id);
      known.add(node.id);
    }
    for (const node of plan.nodes) {
      for (const dep of node.dependsOn) {
        if (!known.has(dep)) {
          context.addIssue({
            code: "custom",
            path: ["nodes"],
            message: `Node ${node.id} depends on unknown node: ${dep}`
          });
        }
        if (dep === node.id) {
          context.addIssue({
            code: "custom",
            path: ["nodes"],
            message: `Node ${node.id} depends on itself`
          });
        }
      }
    }
  });
export type DagPlan = z.infer<typeof DagPlanSchema>;

export const DagRunOptionsSchema = z
  .object({
    /** Max concurrent workers running ready nodes. Hard-capped at 32. */
    concurrency: z.number().int().positive().max(32).default(4),
    /**
     * If true, when a node fails, downstream nodes that depend on it are
     * marked `skipped` instead of running. The caller keeps the failure
     * visible in the report. The runner never hides failures.
     */
    skipOnFailure: z.boolean().default(false)
  })
  .strict();
export type DagRunOptions = z.input<typeof DagRunOptionsSchema>;
export type ParsedDagRunOptions = z.infer<typeof DagRunOptionsSchema>;

export const DagNodeResultSchema = z
  .object({
    nodeId: z.string().trim().min(1),
    state: DagNodeStateSchema,
    /** Runtime stamp identifying the module that produced this result. */
    startedBy: z.string().trim().min(1).optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number().nonnegative().max(86_400_000).optional(),
    /** Worker output for this node. Opaque — the caller owns the shape. */
    output: z.unknown().optional(),
    error: z.string().trim().min(1).optional()
  })
  .strict();
export type DagNodeResult = z.infer<typeof DagNodeResultSchema>;

export const DagRunStatusSchema = z.enum(["completed", "failed", "cancelled"]);
export type DagRunStatus = z.infer<typeof DagRunStatusSchema>;

export const DagRunReportSchema = z
  .object({
    objective: z.string().trim().min(1),
    status: DagRunStatusSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().nonnegative().max(86_400_000),
    /**
     * Original plan nodes by id. Frozen shape — the runner never mutates the
     * caller's plan input.
     */
    plan: z.array(DagNodeSchema),
    /** One entry per node, indexed by id. Failed-and-suppressed nodes are `skipped`. */
    results: z.array(DagNodeResultSchema),
    /**
     * Structured error messages for cycle/dep/unknown faults that prevented
     * the run from starting. Per-node failures live in `results`, not here.
     */
    blockers: z.array(z.string())
  })
  .strict()
  .superRefine(assertTimestampOrder);
export type DagRunReport = z.infer<typeof DagRunReportSchema>;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * A worker receives one node at a time. The handler is fully owned by the
 * caller — the runner will never start a worker without an explicit handler
 * being injected.
 */
export type DagWorker = (node: DagNode, upstream: ReadonlyMap<string, DagNodeResult>) => Promise<unknown> | unknown;

/**
 * The fan-in hook. Fires once per wave AFTER every node in the current
 * wave has settled. Returns a non-null `DagPlan` to merge new nodes into
 * the scheduler (re-plan), or null to terminate the run.
 */
export type DagContinueHook = (context: DagContinueContext) => DagPlan | null | Promise<DagPlan | null>;

export interface DagContinueContext {
  readonly objective: string;
  readonly results: ReadonlyMap<string, DagNodeResult>;
  /** The wave that just settled. */
  readonly wave: readonly DagNode[];
}

export interface RunDagOptions {
  readonly plan: DagPlan;
  readonly worker: DagWorker;
  readonly continueHook?: DagContinueHook;
  readonly options?: DagRunOptions;
  /** Caller-supplied abort signal. When tripped, the runner stops scheduling NEW waves. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const DAG_RUNNER_RUNTIME_NAME = "guruharness-orchestrator-dag-runner";

/**
 * Run a DAG plan to a steady state. Returns a structured report.
 *
 * Behaviour:
 *  - Validates the plan (unique ids, known deps, no self-edges, no cycle).
 *  - Topologically schedules ready nodes up to `options.concurrency`.
 *  - A node becomes ready when every node in its `dependsOn` is `done`.
 *  - Within a wave, ready nodes run concurrently; the wave only finishes
 *    when every node in it has settled.
 *  - After each wave, `continueHook` runs. If it returns a plan, that plan
 *    is merged in and scheduling continues. If it returns null, the run
 *    ends `completed` (or `failed` if any nodes failed).
 *  - Worker exceptions are captured into the node's result with state
 *    `failed`. The runner does NOT throw — failure is data.
 */
export async function runDag(options: RunDagOptions): Promise<DagRunReport> {
  const parsedOptions = DagRunOptionsSchema.parse(options.options ?? {});
  const plan = DagPlanSchema.parse(options.plan);
  const startedAtDate = new Date();
  const results = new Map<string, DagNodeResult>();
  const blockers: string[] = [];

  for (const node of plan.nodes) {
    results.set(node.id, blankResult(node.id));
  }

  // Detect cycles up-front. Topological sort would loop forever on a cycle;
  // surface it as a structured blocker instead of blowing the stack.
  const cycle = detectCycle(plan.nodes);
  if (cycle) {
    blockers.push(`Cycle detected in DAG: ${cycle.join(" -> ")}`);
    return buildReport(plan, results, blockers, "failed", startedAtDate, new Date());
  }

  let cancelled = false;

  // Main scheduling loop. Each iteration picks whatever is ready across the
  // entire pending set, runs them in a bounded wave, and tries again until
  // no node can make progress.
  while (true) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }

    const ready = pickReady(plan.nodes, results, parsedOptions.skipOnFailure);
    if (ready.length === 0) {
      break;
    }
    await runWave(ready, options.worker, results, parsedOptions.concurrency, options.signal);
  }

  // Fan-in hook: caller may extend or replan once the first wave settles.
  // We pass the full settled view so the caller can decide whether to
  // extend the plan or terminate.
  if (options.continueHook && !cancelled) {
    let hookPlan: DagPlan | null = null;
    try {
      hookPlan = await options.continueHook({
        objective: plan.objective,
        results: snapshot(results),
        wave: [...plan.nodes]
      });
    } catch (error) {
      blockers.push(`continueHook threw: ${formatError(error)}`);
    }

    if (hookPlan) {
      const validatedHookPlan = DagPlanSchema.safeParse(hookPlan);
      if (!validatedHookPlan.success) {
        blockers.push(`continueHook returned an invalid plan: ${validatedHookPlan.error.issues.map(formatIssue).join("; ")}`);
      } else {
        const mergedPlan: DagPlan = {
          objective: plan.objective,
          nodes: [...plan.nodes, ...validatedHookPlan.data.nodes]
        };
        const newCycle = detectCycle(mergedPlan.nodes);
        if (newCycle) {
          blockers.push(`continueHook introduced a cycle: ${newCycle.join(" -> ")}`);
        } else {
          for (const node of validatedHookPlan.data.nodes) {
            if (!results.has(node.id)) {
              results.set(node.id, blankResult(node.id));
            }
          }
          // Continue scheduling across the merged set.
          while (!cancelled) {
            if (options.signal?.aborted) {
              cancelled = true;
              break;
            }
            const readyNext = pickReady(mergedPlan.nodes, results, parsedOptions.skipOnFailure);
            if (readyNext.length === 0) {
              break;
            }
            await runWave(readyNext, options.worker, results, parsedOptions.concurrency, options.signal);
          }
        }
      }
    }
  }

  const endedAtDate = new Date();
  // If the plan leaves nodes pending (e.g. a dep that never resolved), the
  // report still records them as `pending` — the caller can inspect.
  const status: DagRunStatus = cancelled ? "cancelled" : resolveStatus(results);
  return buildReport(plan, results, blockers, status, startedAtDate, endedAtDate);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runWave(
  nodes: readonly DagNode[],
  worker: DagWorker,
  results: Map<string, DagNodeResult>,
  concurrency: number,
  signal: AbortSignal | undefined
): Promise<void> {
  let cursor = 0;

  const pump = async (): Promise<void> => {
    while (cursor < nodes.length) {
      if (signal?.aborted) {
        return;
      }
      const next = nodes[cursor];
      cursor += 1;
      if (!next) {
        return;
      }
      const startedAt = new Date();
      results.set(next.id, {
        nodeId: next.id,
        state: "running",
        startedBy: DAG_RUNNER_RUNTIME_NAME,
        startedAt: startedAt.toISOString()
      });
      try {
        const output = await worker(next, buildUpstreamView(next, results));
        const endedAt = new Date();
        results.set(next.id, {
          nodeId: next.id,
          state: "done",
          startedBy: DAG_RUNNER_RUNTIME_NAME,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          output
        });
      } catch (error) {
        const endedAt = new Date();
        results.set(next.id, {
          nodeId: next.id,
          state: "failed",
          startedBy: DAG_RUNNER_RUNTIME_NAME,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          error: formatError(error)
        });
      }
    }
  };

  const lanes = Array.from({ length: Math.min(concurrency, nodes.length) }, () => pump());
  await Promise.all(lanes);
}

function pickReady(
  nodes: readonly DagNode[],
  results: ReadonlyMap<string, DagNodeResult>,
  skipOnFailure: boolean
): DagNode[] {
  const ready: DagNode[] = [];
  for (const node of nodes) {
    const result = results.get(node.id);
    if (!result || result.state !== "pending") {
      continue;
    }
    let allDepsDone = true;
    let anyDepFailed = false;
    for (const dep of node.dependsOn) {
      const depResult = results.get(dep);
      if (!depResult) {
        // Unknown dep — the schema should have caught this. Treat as
        // unresolved; the cycle check covers the rest.
        allDepsDone = false;
        break;
      }
      if (depResult.state === "done") {
        continue;
      }
      if (depResult.state === "failed" || depResult.state === "skipped") {
        anyDepFailed = true;
      }
      allDepsDone = false;
      break;
    }
    if (allDepsDone) {
      ready.push(node);
    } else if (anyDepFailed && skipOnFailure) {
      // Mark downstream nodes as skipped so the report records the chain.
      results.set(node.id, {
        nodeId: node.id,
        state: "skipped",
        startedBy: DAG_RUNNER_RUNTIME_NAME,
        error: "Upstream node failed; downstream skipped."
      });
    }
  }
  return ready;
}

function buildUpstreamView(node: DagNode, results: ReadonlyMap<string, DagNodeResult>): ReadonlyMap<string, DagNodeResult> {
  const view = new Map<string, DagNodeResult>();
  for (const dep of node.dependsOn) {
    const result = results.get(dep);
    if (result) {
      view.set(dep, result);
    }
  }
  return view;
}

function detectCycle(nodes: readonly DagNode[]): string[] | null {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (stack.has(id)) {
      const cycleStart = path.indexOf(id);
      return cycleStart >= 0 ? [...path.slice(cycleStart), id] : [...path, id];
    }
    if (visited.has(id)) {
      return null;
    }
    visited.add(id);
    stack.add(id);
    path.push(id);
    const node = nodes.find((n) => n.id === id);
    if (node) {
      for (const dep of node.dependsOn) {
        const cycle = visit(dep);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.delete(id);
    path.pop();
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function resolveStatus(results: ReadonlyMap<string, DagNodeResult>): DagRunStatus {
  for (const result of results.values()) {
    if (result.state === "failed") {
      return "failed";
    }
  }
  return "completed";
}

function snapshot(results: ReadonlyMap<string, DagNodeResult>): ReadonlyMap<string, DagNodeResult> {
  return new Map(results);
}

function blankResult(nodeId: string): DagNodeResult {
  return { nodeId, state: "pending", startedBy: DAG_RUNNER_RUNTIME_NAME };
}

function buildReport(
  plan: DagPlan,
  results: ReadonlyMap<string, DagNodeResult>,
  blockers: readonly string[],
  status: DagRunStatus,
  startedAtDate: Date,
  endedAtDate: Date
): DagRunReport {
  return DagRunReportSchema.parse({
    objective: plan.objective,
    status,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: Math.max(0, endedAtDate.getTime() - startedAtDate.getTime()),
    plan: plan.nodes,
    results: [...results.values()],
    blockers: [...blockers]
  });
}

function formatIssue(issue: { readonly path: readonly PropertyKey[]; readonly message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertTimestampOrder(value: { readonly startedAt: string; readonly endedAt: string }, context: z.RefinementCtx): void {
  const startedAtMs = Date.parse(value.startedAt);
  const endedAtMs = Date.parse(value.endedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return;
  }
  if (endedAtMs < startedAtMs) {
    context.addIssue({
      code: "custom",
      path: ["endedAt"],
      message: "endedAt must be greater than or equal to startedAt."
    });
  }
}
