export type TaskId = string;

export interface Task {
  readonly id: TaskId;
  readonly dependsOn?: readonly TaskId[];
}

export function computeWaves(tasks: readonly Task[]): TaskId[][] {
  if (tasks.length === 0) {
    return [];
  }

  const idToTask = new Map<TaskId, Task>();
  const allIds = new Set<TaskId>();
  for (const task of tasks) {
    if (idToTask.has(task.id)) {
      // duplicate ids: treat as last wins or error; here last
    }
    idToTask.set(task.id, task);
    allIds.add(task.id);
  }

  // Build indegree and adj list (dependents)
  const indegree = new Map<TaskId, number>();
  const dependents = new Map<TaskId, Set<TaskId>>();
  for (const id of allIds) {
    indegree.set(id, 0);
    dependents.set(id, new Set());
  }

  for (const task of tasks) {
    const deps = task.dependsOn ?? [];
    for (const dep of deps) {
      if (!allIds.has(dep)) {
        // missing dep: treat as external ready, or error; here assume all listed or ignore
        continue;
      }
      // dep -> task.id : task depends on dep, so edge dep -> task for topo
      const depSet = dependents.get(dep)!;
      if (!depSet.has(task.id)) {
        depSet.add(task.id);
        indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      }
    }
  }

  // Kahn level order
  const waves: TaskId[][] = [];
  let currentWave: TaskId[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) {
      currentWave.push(id);
    }
  }
  currentWave.sort();

  const processed = new Set<TaskId>();

  while (currentWave.length > 0) {
    waves.push(currentWave);
    const nextWave: TaskId[] = [];
    for (const id of currentWave) {
      processed.add(id);
      const depsOf = dependents.get(id)!;
      for (const dependent of depsOf) {
        const newDeg = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextWave.push(dependent);
        }
      }
    }
    nextWave.sort();
    currentWave = nextWave;
  }

  if (processed.size !== allIds.size) {
    throw new Error('Cycle detected in task dependencies');
  }

  return waves;
}
