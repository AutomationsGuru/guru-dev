export interface Task {
  id: string;
  name: string;
  priority: number;
}

export interface Wave {
  tasks: Task[];
}

export interface WaveConfig {
  maxParallel?: number;
}

export class TaskWaveBatcher {
  private tasks: Map<string, Task> = new Map();
  private dependencies: Map<string, Set<string>> = new Map(); // taskId -> set of taskIds it depends on
  private dependents: Map<string, Set<string>> = new Map(); // taskId -> set of taskIds that depend on it
  private priorities: Map<string, number> = new Map();
  private config: WaveConfig;
  private waves: Wave[] = [];
  private completed: Set<string> = new Set();
  private currentWaveIndex: number = 0;

  constructor(config: WaveConfig = {}) {
    this.config = { maxParallel: config.maxParallel ?? 10 };
  }

  addTask(id: string, name: string, priority: number = 0): void {
    if (this.tasks.has(id)) {
      throw new Error(`Task ${id} already exists`);
    }
    const task: Task = { id, name, priority };
    this.tasks.set(id, task);
    this.priorities.set(id, priority);
    this.dependencies.set(id, new Set());
    this.dependents.set(id, new Set());
  }

  addDependency(taskId: string, dependsOnId: string): void {
    if (!this.tasks.has(taskId) || !this.tasks.has(dependsOnId)) {
      throw new Error('Task not found');
    }
    if (taskId === dependsOnId) {
      throw new Error('Self-dependency not allowed');
    }
    this.dependencies.get(taskId)!.add(dependsOnId);
    this.dependents.get(dependsOnId)!.add(taskId);
  }

  buildWaves(): Wave[] {
    if (this.tasks.size === 0) {
      this.waves = [];
      return [];
    }

    const indegree = new Map<string, number>();
    for (const id of this.tasks.keys()) {
      indegree.set(id, this.dependencies.get(id)!.size);
    }

    const waves: Wave[] = [];
    const processed = new Set<string>();
    let currentLevel: string[] = Array.from(this.tasks.keys()).filter(
      (id) => indegree.get(id) === 0
    );

    while (currentLevel.length > 0) {
      // Sort by priority desc, then id asc for determinism
      currentLevel.sort((a, b) => {
        const pa = this.priorities.get(a)!;
        const pb = this.priorities.get(b)!;
        if (pa !== pb) return pb - pa;
        return a.localeCompare(b);
      });

      const waveTasks: Task[] = currentLevel.map((id) => this.tasks.get(id)!);
      waves.push({ tasks: waveTasks });

      const nextLevel: string[] = [];
      for (const id of currentLevel) {
        processed.add(id);
        for (const dependentId of this.dependents.get(id)!) {
          const newDeg = (indegree.get(dependentId)! - 1);
          indegree.set(dependentId, newDeg);
          if (newDeg === 0) {
            nextLevel.push(dependentId);
          }
        }
      }
      currentLevel = nextLevel;
    }

    if (processed.size !== this.tasks.size) {
      throw new Error('Circular dependency detected');
    }

    this.waves = waves;
    return waves;
  }

  getExecutionOrder(): Task[] {
    if (this.waves.length === 0) {
      this.buildWaves();
    }
    const order: Task[] = [];
    for (const wave of this.waves) {
      order.push(...wave.tasks);
    }
    return order;
  }

  getWaveForTask(taskId: string): number {
    if (this.waves.length === 0) {
      this.buildWaves();
    }
    for (let i = 0; i < this.waves.length; i++) {
      if (this.waves[i].tasks.some((t) => t.id === taskId)) {
        return i;
      }
    }
    return -1;
  }

  getAllWaves(): Wave[] {
    if (this.waves.length === 0 && this.tasks.size > 0) {
      this.buildWaves();
    }
    return this.waves.map((w) => ({ tasks: [...w.tasks] }));
  }

  getReadyTasks(): Task[] {
    const ready: Task[] = [];
    for (const [id, task] of this.tasks) {
      if (this.completed.has(id)) continue;
      const deps = this.dependencies.get(id)!;
      const allDepsDone = Array.from(deps).every((d) => this.completed.has(d));
      if (allDepsDone) {
        ready.push(task);
      }
    }
    ready.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
    return ready;
  }

  completeTask(taskId: string): void {
    if (!this.tasks.has(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }
    this.completed.add(taskId);
  }

  isComplete(): boolean {
    return this.tasks.size > 0 && this.completed.size === this.tasks.size;
  }
}
