import {
  StepCheckpointSchema,
  type StepCheckpoint,
  type StepCheckpointRestore,
  type StepCheckpointSnapshot
} from "./stepCheckpoint.js";

export interface StepCheckpointStoreOptions {
  /** Maximum restore points retained in memory. Defaults to 20. */
  readonly maxDepth?: number;
}

/**
 * Bounded in-memory restore-point stack for mutating agent steps.
 *
 * Each checkpoint preserves the content that existed before a step. `undoLast()`
 * removes only the most recent checkpoint and returns exactly the snapshots the
 * caller must restore; filesystem writes remain outside this pure store.
 */
export class StepCheckpointStore {
  private readonly stack: StepCheckpoint[] = [];
  readonly maxDepth: number;

  constructor(options: StepCheckpointStoreOptions = {}) {
    const { maxDepth = 20 } = options;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new Error(`StepCheckpointStore maxDepth must be a positive integer, got ${maxDepth}.`);
    }
    this.maxDepth = maxDepth;
  }

  get depth(): number {
    return this.stack.length;
  }

  /**
   * Push a pre-mutation snapshot set. New pushes evict the oldest checkpoint
   * once the configured depth is reached.
   */
  pushCheckpoint(id: string, snapshots: readonly StepCheckpointSnapshot[]): StepCheckpoint {
    const checkpoint = StepCheckpointSchema.parse({ id, snapshots });
    const stored = cloneCheckpoint(checkpoint);
    if (this.stack.length === this.maxDepth) {
      this.stack.shift();
    }
    this.stack.push(stored);
    return cloneCheckpoint(stored);
  }

  /**
   * Remove the newest restore point and return the content snapshots to apply.
   * Empty-stack undo fails closed rather than silently claiming success.
   */
  undoLast(): StepCheckpointRestore {
    const checkpoint = this.stack.pop();
    if (!checkpoint) {
      throw new Error("Step checkpoint stack is empty; no restore point is available.");
    }
    const restored = cloneCheckpoint(checkpoint);
    return {
      checkpoint: restored,
      snapshots: restored.snapshots.map((snapshot) => ({ ...snapshot }))
    };
  }
}

function cloneCheckpoint(checkpoint: StepCheckpoint): StepCheckpoint {
  return {
    id: checkpoint.id,
    snapshots: checkpoint.snapshots.map((snapshot) => ({ ...snapshot }))
  };
}
