/**
 * Subagent Orchestrator for Self-Build Developer Loop
 *
 * Coordinates the spawning and lifecycle of subagents for recursive
 * self-building. Manages task distribution, worktree isolation, and
 * result aggregation.
 *
 * DOX: See planning/SELF-BUILD-DEVELOPER-LOOP.md
 */

import { WorktreeManager, WorktreeInfo, defaultWorktreeManager } from './worktreeManager.js';
import { OutputIntegrator, defaultIntegrator } from './integrator.js';

export interface BuildOptions {
  maxDepth?: number;
  maxParallel?: number;
  worktreeIsolation?: boolean;
  cleanupOnComplete?: boolean;
  verbose?: boolean;
}

export interface SubagentTask {
  id: string;
  description: string;
  prompt: string;
  canSpawnSubagents?: boolean;
  dependencies?: string[];
  priority?: number;
}

export interface BuildResult {
  success: boolean;
  summary: string;
  subagentsSpawned: number;
  outputsIntegrated: string[];
  worktreesCleaned: number;
  duration: number;
  errors?: string[];
}

export interface SubagentResult {
  taskId: string;
  status: 'completed' | 'failed' | 'partial';
  summary: string;
  outputs?: string[];
  subagentsSpawned?: number;
  duration?: number;
  error?: string;
}

export interface OrchestrationContext {
  goal: string;
  depth: number;
  parentWorktree?: string;
  options: BuildOptions;
}

export class OrchestrationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

export class SubagentOrchestrator {
  private worktreeManager: WorktreeManager;
  private integrator: OutputIntegrator;
  private spawnedCount: number = 0;
  private results: Map<string, SubagentResult> = new Map();

  constructor(
    worktreeManager?: WorktreeManager,
    integrator?: OutputIntegrator
  ) {
    this.worktreeManager = worktreeManager || defaultWorktreeManager;
    this.integrator = integrator || defaultIntegrator;
  }

  /**
   * Execute a high-level build goal with recursive subagent orchestration
   */
  async executeGoal(
    goal: string,
    options: BuildOptions = {}
  ): Promise<BuildResult> {
    const startTime = Date.now();
    const context: OrchestrationContext = {
      goal,
      depth: 0,
      options: {
        maxDepth: options.maxDepth ?? 3,
        maxParallel: options.maxParallel ?? 4,
        worktreeIsolation: options.worktreeIsolation ?? true,
        cleanupOnComplete: options.cleanupOnComplete ?? true,
        verbose: options.verbose ?? false
      }
    };

    const result: BuildResult = {
      success: true,
      summary: '',
      subagentsSpawned: 0,
      outputsIntegrated: [],
      worktreesCleaned: 0,
      duration: 0
    };

    try {
      // Phase 1: Analyze goal and create task plan
      const tasks = await this.planTasks(goal, context);

      if (context.options.verbose) {
        console.log(`[Orchestrator] Planned ${tasks.length} tasks for goal: ${goal}`);
      }

      // Phase 2: Execute tasks with recursive subagent spawning
      const taskResults = await this.executeTasks(tasks, context);

      // Phase 3: Aggregate results
      result.subagentsSpawned = this.spawnedCount;
      result.outputsIntegrated = taskResults
        .filter(r => r.outputs)
        .flatMap(r => r.outputs!);

      const failedTasks = taskResults.filter(r => r.status === 'failed');
      if (failedTasks.length > 0) {
        result.success = false;
        result.errors = failedTasks.map(t => `${t.taskId}: ${t.error}`);
      }

      result.summary = `Completed ${taskResults.length} tasks, spawned ${result.subagentsSpawned} subagents`;

      // Phase 4: Cleanup if requested
      if (context.options.cleanupOnComplete) {
        result.worktreesCleaned = await this.worktreeManager.cleanupAll({
          discardChanges: true
        });
      }

      result.duration = Date.now() - startTime;

      return result;
    } catch (error) {
      result.success = false;
      result.errors = [error instanceof Error ? error.message : String(error)];
      result.duration = Date.now() - startTime;
      result.summary = 'Orchestration failed';

      return result;
    }
  }

  /**
   * Spawn a single subagent for a specific task
   */
  async spawnSubagent(
    task: SubagentTask,
    context: OrchestrationContext
  ): Promise<SubagentResult> {
    const startTime = Date.now();
    this.spawnedCount++;

    let worktreeInfo: WorktreeInfo | undefined;

    try {
      // Create isolated worktree if isolation is enabled
      if (context.options.worktreeIsolation) {
        worktreeInfo = await this.worktreeManager.createWorktree(task.id);
      }

      // Execute the task (in a real implementation, this would spawn an actual agent)
      // For now, we simulate the execution
      const result = await this.executeTaskInWorktree(task, worktreeInfo, context);

      const subagentResult: SubagentResult = {
        taskId: task.id,
        status: result.success ? 'completed' : 'failed',
        summary: result.summary,
        outputs: result.outputs,
        subagentsSpawned: result.subagentsSpawned,
        duration: Date.now() - startTime
      };

      this.results.set(task.id, subagentResult);

      return subagentResult;
    } catch (error) {
      const errorResult: SubagentResult = {
        taskId: task.id,
        status: 'failed',
        summary: 'Task execution failed',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      };

      this.results.set(task.id, errorResult);
      return errorResult;
    }
  }

  /**
   * Coordinate execution of multiple tasks
   */
  async coordinateSubagents(
    tasks: SubagentTask[],
    context: OrchestrationContext
  ): Promise<SubagentResult[]> {
    // Sort by priority and dependencies
    const sortedTasks = this.topologicalSort(tasks);

    const results: SubagentResult[] = [];
    const maxParallel = context.options.maxParallel || 4;

    // Execute in batches respecting parallelism limit
    for (let i = 0; i < sortedTasks.length; i += maxParallel) {
      const batch = sortedTasks.slice(i, i + maxParallel);
      const batchPromises = batch.map(task => this.spawnSubagent(task, context));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Plan tasks based on the goal description
   */
  private async planTasks(
    goal: string,
    context: OrchestrationContext
  ): Promise<SubagentTask[]> {
    // In a real implementation, this would use the planner module
    // For now, create a simple task breakdown based on goal keywords

    const tasks: SubagentTask[] = [];

    if (goal.toLowerCase().includes('build') || goal.toLowerCase().includes('compile')) {
      tasks.push({
        id: 'build',
        description: 'Execute TypeScript compilation',
        prompt: `Build the project: ${goal}`,
        canSpawnSubagents: true,
        priority: 10
      });
    }

    if (goal.toLowerCase().includes('test')) {
      tasks.push({
        id: 'test',
        description: 'Run test suite',
        prompt: `Test the implementation: ${goal}`,
        canSpawnSubagents: false,
        priority: 8,
        dependencies: ['build']
      });
    }

    if (goal.toLowerCase().includes('validate') || goal.toLowerCase().includes('verify')) {
      tasks.push({
        id: 'validate',
        description: 'Validate build outputs',
        prompt: `Validate the build: ${goal}`,
        canSpawnSubagents: true,
        priority: 5
      });
    }

    // Default task if no specific keywords found
    if (tasks.length === 0) {
      tasks.push({
        id: 'execute',
        description: 'Execute the build goal',
        prompt: goal,
        canSpawnSubagents: true,
        priority: 10
      });
    }

    return tasks;
  }

  /**
   * Execute a task within a worktree context
   */
  private async executeTaskInWorktree(
    task: SubagentTask,
    worktreeInfo: WorktreeInfo | undefined,
    context: OrchestrationContext
  ): Promise<{ success: boolean; summary: string; outputs?: string[]; subagentsSpawned?: number }> {
    const workDir = worktreeInfo?.path || process.cwd();

    // Simulate task execution
    // In production, this would actually invoke the Agent tool or spawn a subprocess

    if (context.options.verbose) {
      console.log(`[Orchestrator] Executing task ${task.id} in ${workDir}`);
    }

    // Check if task can spawn subagents and we're under depth limit
    let subagentsSpawned = 0;
    if (task.canSpawnSubagents && context.depth < (context.options.maxDepth || 3)) {
      // Recursively spawn subagents for subtasks
      const subTasks = await this.decomposeTask(task, context);
      const subContext: OrchestrationContext = {
        ...context,
        depth: context.depth + 1,
        parentWorktree: worktreeInfo?.path
      };

      const subResults = await this.coordinateSubagents(subTasks, subContext);
      subagentsSpawned = subResults.length;
    }

    return {
      success: true,
      summary: `Completed task: ${task.description}`,
      outputs: [`${task.id}-output`],
      subagentsSpawned
    };
  }

  /**
   * Decompose a task into subtasks for recursive execution
   */
  private async decomposeTask(
    task: SubagentTask,
    context: OrchestrationContext
  ): Promise<SubagentTask[]> {
    // Create subtasks based on task type
    // This enables the recursive spawning pattern

    return [
      {
        id: `${task.id}-prep`,
        description: `Prepare for: ${task.description}`,
        prompt: `Prepare environment for: ${task.prompt}`,
        canSpawnSubagents: false,
        priority: 5
      },
      {
        id: `${task.id}-execute`,
        description: `Execute: ${task.description}`,
        prompt: task.prompt,
        canSpawnSubagents: context.depth < (context.options.maxDepth || 3) - 1,
        priority: 10
      },
      {
        id: `${task.id}-verify`,
        description: `Verify: ${task.description}`,
        prompt: `Verify completion of: ${task.prompt}`,
        canSpawnSubagents: false,
        priority: 3,
        dependencies: [`${task.id}-execute`]
      }
    ];
  }

  /**
   * Topologically sort tasks respecting dependencies
   */
  private topologicalSort(tasks: SubagentTask[]): SubagentTask[] {
    const sorted: SubagentTask[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (task: SubagentTask) => {
      if (visited.has(task.id)) return;
      if (visiting.has(task.id)) {
        // Circular dependency - just add it
        return;
      }

      visiting.add(task.id);

      // Visit dependencies first
      if (task.dependencies) {
        for (const depId of task.dependencies) {
          const dep = tasks.find(t => t.id === depId);
          if (dep) visit(dep);
        }
      }

      visiting.delete(task.id);
      visited.add(task.id);
      sorted.push(task);
    };

    // Sort by priority first, then topological order
    const prioritizedTasks = [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const task of prioritizedTasks) {
      visit(task);
    }

    return sorted;
  }

  /**
   * Get execution results for all tasks
   */
  getResults(): Map<string, SubagentResult> {
    return new Map(this.results);
  }

  /**
   * Reset orchestrator state
   */
  reset(): void {
    this.spawnedCount = 0;
    this.results.clear();
  }
}

// Export singleton
export const defaultOrchestrator = new SubagentOrchestrator();
