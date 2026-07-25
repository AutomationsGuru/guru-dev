/**
 * Task dependency waves (IDEA-F139-TASK-WAVES-01).
 *
 * Given tasks with `id` + optional `dependsOn[]`, compute ordered waves of
 * concurrent-ready task ids. Wave 1 contains every task whose dependencies are
 * all satisfied by the empty set; wave N contains the tasks that become ready
 * once every task in waves 1..N-1 has completed. Within a wave, ids are sorted
 * with `localeCompare` so output is deterministic for a given input set.
 */

export type TaskId = string;

export interface DependencyTask {
  readonly id: TaskId;
  readonly dependsOn?: readonly TaskId[];
}

export type TaskDependencyErrorCode =
  | "DUPLICATE_TASK_ID"
  | "UNKNOWN_DEPENDENCY"
  | "DEPENDENCY_CYCLE";

/**
 * Structured failure for {@link computeWaves}. `code` identifies the failure
 * class; `cycle` carries the dependency path that closes the loop when the
 * code is `DEPENDENCY_CYCLE` (first element repeated at the end).
 */
export class TaskDependencyError extends Error {
  readonly code: TaskDependencyErrorCode;
  readonly cycle: readonly TaskId[] | undefined;

  constructor(code: TaskDependencyErrorCode, message: string, cycle?: readonly TaskId[]) {
    super(message);
    this.name = "TaskDependencyError";
    this.code = code;
    this.cycle = cycle === undefined ? undefined : Object.freeze([...cycle]);
  }
}

/**
 * Compute ordered waves of concurrent-ready task ids via Kahn's algorithm.
 *
 * @throws {TaskDependencyError} with code `DUPLICATE_TASK_ID` when two tasks
 *   share an id, `UNKNOWN_DEPENDENCY` when a task depends on an id that no
 *   task declares, or `DEPENDENCY_CYCLE` when the remaining subgraph cannot be
 *   scheduled (including self-dependency).
 */
export function computeWaves(tasks: readonly DependencyTask[]): TaskId[][] {
  const dependencies = new Map<TaskId, readonly TaskId[]>();

  for (const task of tasks) {
    if (dependencies.has(task.id)) {
      throw new TaskDependencyError(
        "DUPLICATE_TASK_ID",
        `Duplicate task id: ${task.id}`
      );
    }
    dependencies.set(task.id, task.dependsOn ?? []);
  }

  const dependents = new Map<TaskId, TaskId[]>();
  const indegree = new Map<TaskId, number>();
  for (const id of dependencies.keys()) {
    dependents.set(id, []);
    indegree.set(id, 0);
  }

  for (const [id, deps] of dependencies) {
    const uniqueDeps = new Set(deps);
    for (const dep of uniqueDeps) {
      if (!dependencies.has(dep)) {
        throw new TaskDependencyError(
          "UNKNOWN_DEPENDENCY",
          `Task ${id} depends on unknown task id: ${dep}`
        );
      }
      dependents.get(dep)?.push(id);
    }
    indegree.set(id, uniqueDeps.size);
  }

  const waves: TaskId[][] = [];
  let scheduled = 0;
  let frontier: TaskId[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) {
      frontier.push(id);
    }
  }

  while (frontier.length > 0) {
    frontier.sort((left, right) => left.localeCompare(right));
    waves.push(frontier);
    scheduled += frontier.length;

    const next: TaskId[] = [];
    for (const id of frontier) {
      for (const dependent of dependents.get(id) ?? []) {
        const degree = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, degree);
        if (degree === 0) {
          next.push(dependent);
        }
      }
    }
    frontier = next;
  }

  if (scheduled !== dependencies.size) {
    const cycle = findCycle(dependencies);
    throw new TaskDependencyError(
      "DEPENDENCY_CYCLE",
      `Dependency cycle detected involving: ${cycle.join(" -> ")}`,
      cycle
    );
  }

  return waves;
}

/**
 * Depth-first search for one concrete cycle path among the tasks that were
 * never scheduled. Returns the path with the starting id repeated at the end
 * (e.g. `["a", "b", "a"]`). Falls back to the unscheduled id set when the
 * residual graph is unexpectedly acyclic.
 */
function findCycle(dependencies: ReadonlyMap<TaskId, readonly TaskId[]>): TaskId[] {
  const visiting = new Set<TaskId>();
  const done = new Set<TaskId>();

  const visit = (id: TaskId, path: TaskId[]): TaskId[] | undefined => {
    if (done.has(id)) {
      return undefined;
    }
    if (visiting.has(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    visiting.add(id);
    for (const dep of dependencies.get(id) ?? []) {
      const cycle = visit(dep, [...path, id]);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    visiting.delete(id);
    done.add(id);
    return undefined;
  };

  for (const id of dependencies.keys()) {
    const cycle = visit(id, []);
    if (cycle !== undefined) {
      return cycle;
    }
  }

  return [...dependencies.keys()].sort((left, right) => left.localeCompare(right));
}
