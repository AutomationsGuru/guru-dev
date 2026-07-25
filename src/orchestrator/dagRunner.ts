/**
 * Orchestrator DAG runner (IDEA-F267-DAG-ORCH-01 / R-AU-DAG).
 *
 * The orchestrator emits a plan as a DAG of nodes with explicit dependencies;
 * this runner schedules every READY node to a worker (parallel up to a bounded
 * concurrency cap), fans results back into dependents as inputs, and exposes a
 * fan-in continue/replan hook after each node settles so the orchestrator can
 * keep going, replan a stale subgraph, or stop the run.
 *
 * Bounded by construction (never-stuck, §failure paths are observable):
 * - invalid plans (duplicate ids, unknown deps, cycles) are rejected BEFORE the
 *   first worker runs — a malformed plan can never hang the scheduler;
 * - a failed node skips its dependents (cascading) instead of dead-ending;
 * - replanning is hard-capped by `maxReplans` so a hook that always asks for a
 *   replan cannot loop forever.
 */

/** A single unit of orchestrated work. `deps` names node ids that must settle first. */
export interface DagNode {
  readonly id: string;
  readonly deps?: readonly string[];
  /** Opaque orchestrator payload forwarded untouched to the worker. */
  readonly payload?: unknown;
}

/** The orchestrator's plan: a flat node list whose edges are expressed by `deps`. */
export interface DagPlan {
  readonly id: string;
  readonly nodes: readonly DagNode[];
}

/** Inputs a node receives: dep node id → that dep's output string. */
export type DagNodeInputs = ReadonlyMap<string, string>;

/** Executes one node. Injected — the runner owns scheduling, never execution. */
export type DagWorker = (node: DagNode, inputs: DagNodeInputs) => Promise<string>;

/** Fan-in event delivered to the continue/replan hook after a node settles. */
export interface DagNodeSettledEvent {
  readonly nodeId: string;
  readonly state: "done" | "failed";
  /** Worker output when state is "done". */
  readonly output?: string;
  /** Error message when state is "failed". */
  readonly error?: string;
  /** Outputs of every node settled so far (immutable snapshot). */
  readonly outputs: DagNodeInputs;
}

/** The hook's verdict after each fan-in event. */
export type DagContinueDecision =
  | { readonly action: "continue" }
  | { readonly action: "replan"; readonly reason?: string }
  | { readonly action: "abort"; readonly reason?: string };

export interface RunDagOptions {
  /** Max workers in flight at once. Hard-capped at 16 (swarm contract parity). */
  readonly maxConcurrency?: number;
  /**
   * Max replan requests honored per run. Bounds the continue/replan loop so a
   * hook that always replans terminates. Default 3; hard cap 8.
   */
  readonly maxReplans?: number;
  /** Fan-in hook invoked (in settle order) after each node finishes or fails. */
  readonly onNodeSettled?: (event: DagNodeSettledEvent) => DagContinueDecision | Promise<DagContinueDecision>;
}

export type DagRunStatus = "completed" | "failed" | "aborted";

export interface DagRunResult {
  readonly status: DagRunStatus;
  /** node id → worker output for every node that completed. */
  readonly outputs: ReadonlyMap<string, string>;
  /** Node ids that ran and rejected. */
  readonly failed: readonly string[];
  /** Node ids that never ran because a dependency failed/skipped, or the run aborted. */
  readonly skipped: readonly string[];
  /** Replans actually performed (bounded by maxReplans). */
  readonly replanCount: number;
  /** Hook-supplied reason when status is "aborted". */
  readonly abortReason?: string;
}

/** Plan has a dependency cycle — rejected before any worker runs. */
export class DagCycleError extends Error {
  readonly code = "dag_cycle";
  constructor(readonly cycle: readonly string[]) {
    super(`DAG plan has a dependency cycle: ${cycle.join(" -> ")}`);
    this.name = "DagCycleError";
  }
}

/** Plan is structurally invalid (duplicate id or unknown dep) — rejected up front. */
export class DagPlanError extends Error {
  readonly code = "dag_plan_invalid";
  constructor(message: string) {
    super(message);
    this.name = "DagPlanError";
  }
}

const MAX_CONCURRENCY_CEILING = 16;
const MAX_REPLANS_CEILING = 8;
const DEFAULT_MAX_REPLANS = 3;

type NodeState = "pending" | "ready" | "running" | "done" | "failed" | "skipped";

function validatePlan(plan: DagPlan): Map<string, DagNode> {
  const byId = new Map<string, DagNode>();
  for (const node of plan.nodes) {
    if (byId.has(node.id)) {
      throw new DagPlanError(`Duplicate node id "${node.id}" in plan "${plan.id}".`);
    }
    byId.set(node.id, node);
  }
  for (const node of plan.nodes) {
    for (const dep of node.deps ?? []) {
      if (!byId.has(dep)) {
        throw new DagPlanError(`Node "${node.id}" depends on unknown node "${dep}" in plan "${plan.id}".`);
      }
      if (dep === node.id) {
        throw new DagCycleError([node.id, node.id]);
      }
    }
  }
  // Cycle check via iterative DFS (white/gray/black). Gray revisit = cycle.
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (start: string): void => {
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: start, expanded: false }];
    const path: string[] = [];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (!top.expanded) {
        if (color.get(top.id) === 2) {
          stack.pop();
          continue;
        }
        color.set(top.id, 1);
        path.push(top.id);
        top.expanded = true;
        for (const dep of byId.get(top.id)!.deps ?? []) {
          if (color.get(dep) === 1) {
            const cycleStart = path.indexOf(dep);
            throw new DagCycleError([...path.slice(cycleStart), dep]);
          }
          if (color.get(dep) !== 2) {
            stack.push({ id: dep, expanded: false });
          }
        }
      } else {
        color.set(top.id, 2);
        path.pop();
        stack.pop();
      }
    }
  };
  for (const node of plan.nodes) {
    if (color.get(node.id) === undefined) {
      visit(node.id);
    }
  }
  return byId;
}

/**
 * Runs a plan DAG to settlement. Resolves once every node is done, failed, or
 * skipped — never before, never after, never hangs on a valid plan.
 */
export async function runDag(plan: DagPlan, worker: DagWorker, options: RunDagOptions = {}): Promise<DagRunResult> {
  const byId = validatePlan(plan);
  const maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? MAX_CONCURRENCY_CEILING, MAX_CONCURRENCY_CEILING));
  const maxReplans = Math.max(0, Math.min(options.maxReplans ?? DEFAULT_MAX_REPLANS, MAX_REPLANS_CEILING));

  const states = new Map<string, NodeState>();
  const remainingDeps = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const outputs = new Map<string, string>();
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const node of plan.nodes) {
    const deps = node.deps ?? [];
    states.set(node.id, deps.length === 0 ? "ready" : "pending");
    remainingDeps.set(node.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  let replanCount = 0;
  let abortReason: string | undefined;
  let running = 0;
  let settledCount = 0;
  const total = plan.nodes.length;

  const skipSubtree = (nodeId: string): void => {
    // Cascade: dependents of a failed/skipped node can never become ready.
    for (const childId of dependents.get(nodeId) ?? []) {
      if (states.get(childId) === "pending") {
        states.set(childId, "skipped");
        skipped.push(childId);
        settledCount += 1;
        skipSubtree(childId);
      }
    }
  };

  const settleLoop = new Promise<void>((resolveAll) => {
    const maybeFinish = (): void => {
      if (settledCount === total && running === 0) {
        resolveAll();
      }
    };

    const pump = (): void => {
      if (abortReason !== undefined) {
        // Abort: every node that never started is reported skipped — honest, bounded.
        for (const node of plan.nodes) {
          const s = states.get(node.id);
          if (s === "pending" || s === "ready") {
            states.set(node.id, "skipped");
            skipped.push(node.id);
            settledCount += 1;
          }
        }
        maybeFinish();
        return;
      }
      if (running >= maxConcurrency) {
        return;
      }
      for (const node of plan.nodes) {
        if (running >= maxConcurrency) {
          return;
        }
        if (states.get(node.id) !== "ready") {
          continue;
        }
        states.set(node.id, "running");
        running += 1;
        const inputs = new Map<string, string>();
        for (const dep of node.deps ?? []) {
          const out = outputs.get(dep);
          if (out !== undefined) {
            inputs.set(dep, out);
          }
        }
        worker(node, inputs).then(
          (output) => {
            onSettled(node, "done", output, undefined);
          },
          (error: unknown) => {
            onSettled(node, "failed", undefined, error instanceof Error ? error.message : String(error));
          }
        );
      }
    };

    const onSettled = (node: DagNode, state: "done" | "failed", output: string | undefined, error: string | undefined): void => {
      running -= 1;
      settledCount += 1;
      states.set(node.id, state);
      if (state === "done") {
        outputs.set(node.id, output ?? "");
      } else {
        failed.push(node.id);
        skipSubtree(node.id);
      }

      const finish = (unblockDependents: boolean): void => {
        if (unblockDependents) {
          // Unblock dependents whose deps all settled successfully.
          for (const childId of dependents.get(node.id) ?? []) {
            if (states.get(childId) !== "pending") {
              continue;
            }
            const left = remainingDeps.get(childId)! - 1;
            remainingDeps.set(childId, left);
            if (left === 0) {
              states.set(childId, "ready");
            }
          }
        }
        pump();
        maybeFinish();
      };

      const hook = options.onNodeSettled;
      if (!hook) {
        finish(true);
        return;
      }
      Promise.resolve(
        hook({
          nodeId: node.id,
          state,
          ...(output !== undefined ? { output } : {}),
          ...(error !== undefined ? { error } : {}),
          outputs: new Map(outputs)
        })
      ).then(
        (decision) => {
          let replanned = false;
          if (decision.action === "abort" && abortReason === undefined) {
            abortReason = decision.reason ?? "aborted by continue/replan hook";
          } else if (decision.action === "replan" && replanCount < maxReplans && abortReason === undefined) {
            replanCount += 1;
            replanned = true;
            // Replan: re-run this node and its not-yet-started downstream subgraph
            // against fresh outputs. Running nodes are left to settle; skipped
            // nodes stay skipped (their branch was already contained).
            //
            // Bookkeeping invariant: settledCount tracks how many of the `total`
            // nodes have a FINAL settle. A reset node's current settle is
            // discarded (settledCount -= 1) and its re-run settles again later —
            // net zero. A dependent's arming is rebuilt from scratch against the
            // post-reset dep states, so no separate consumption tracking is
            // needed: a dep still "done" contributes its existing output as
            // input; a dep that will re-run is waited on afresh.
            // Replan invalidates the settled node's INPUT cone and everything
            // downstream of it: the node is stale because its inputs are
            // suspect, so its dependency cone re-runs and the fresh outputs
            // propagate back down. Running nodes are left to settle; skipped
            // nodes stay skipped (their branch was already contained).
            //
            // Two passes so no node fires on a stale mid-reset dep state:
            // pass 1 collects the cone and strips settled bookkeeping;
            // pass 2 rebuilds arming against the FINAL dep states. A node is
            // ready only if none of its deps will produce a new settle.
            const subgraph = new Set<string>();
            const collect = (id: string): void => {
              if (subgraph.has(id)) {
                return;
              }
              const s = states.get(id);
              if (s === "running" || s === "skipped") {
                return;
              }
              subgraph.add(id);
              for (const depId of byId.get(id)!.deps ?? []) {
                collect(depId);
              }
              for (const childId of dependents.get(id) ?? []) {
                collect(childId);
              }
            };
            collect(node.id);
            for (const id of subgraph) {
              const s = states.get(id);
              if (s === "done" || s === "failed") {
                settledCount -= 1;
                outputs.delete(id);
                const fi = failed.indexOf(id);
                if (fi >= 0) {
                  failed.splice(fi, 1);
                }
              }
              states.set(id, "pending");
            }
            for (const id of subgraph) {
              const deps = byId.get(id)!.deps ?? [];
              // Wait only on deps that will produce a NEW settle: those still
              // running or re-armed by this reset. A dep that stays done keeps
              // its output as valid input (its settle already counted, no new
              // one will come).
              const waitingOn = deps.filter((dep) => {
                const ds = states.get(dep);
                return ds === "running" || ds === "pending" || (ds === "ready" && subgraph.has(dep));
              }).length;
              remainingDeps.set(id, waitingOn);
              states.set(id, waitingOn === 0 ? "ready" : "pending");
            }
          }
          // A replanned node re-runs and will re-settle — its dependents arm from
          // the re-run's settle, not from this one. Otherwise this settle unblocks
          // them normally.
          finish(!replanned);
        },
        () => {
          // A broken hook must not wedge the scheduler — treat as continue.
          finish(true);
        }
      );
    };

    pump();
    maybeFinish();
  });

  await settleLoop;

  const status: DagRunStatus =
    abortReason !== undefined ? "aborted" : failed.length > 0 ? "failed" : "completed";

  return {
    status,
    outputs,
    failed,
    skipped,
    replanCount,
    ...(abortReason !== undefined ? { abortReason } : {})
  };
}
