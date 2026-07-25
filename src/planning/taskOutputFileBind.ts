/**
 * Task output file bind: allows a task to be bound to an optional outputFile path,
 * which is then recorded on its completion receipt.
 */

export interface BindableTask {
  readonly id: string;
  readonly outputFile?: string;
  [key: string]: unknown;
}

export interface TaskCompletionReceipt {
  readonly taskId: string;
  readonly ok: boolean;
  readonly outputFile?: string;
  readonly timestamp: string;
  [key: string]: unknown;
}

/**
 * Binds an output file path to a task.
 */
export function bindOutputFile<T extends { id: string }>(task: T, path: string): T & { outputFile: string } {
  return {
    ...task,
    outputFile: path
  };
}

/**
 * Creates a completion receipt for a task, carrying over the outputFile if present.
 */
export function completeTask(task: BindableTask, ok: boolean): TaskCompletionReceipt {
  const receipt: TaskCompletionReceipt = {
    taskId: task.id,
    ok,
    timestamp: new Date().toISOString()
  };

  if (task.outputFile !== undefined) {
    // using object spread or Object.assign to bypass readonly index
    return {
      ...receipt,
      outputFile: task.outputFile
    };
  }

  return receipt;
}
