import type { SwarmTaskRecord, SwarmWorkerMode } from "./schema.js";
import type { SwarmManager } from "./manager.js";

export interface CrewTask {
  readonly prompt: string;
  readonly mode?: "read-only" | "all"; // matches SwarmWorkerMode
  readonly label?: string;
}

export interface CrewSequentialResult {
  readonly success: boolean;
  readonly records: readonly SwarmTaskRecord[];
  readonly finalOutput?: string;
  readonly error?: string;
}

export type CrewPromptBuilder = (
  task: CrewTask,
  previousOutput: string,
  index: number,
  allPreviousOutputs: readonly string[]
) => string;

export const defaultCrewPromptBuilder: CrewPromptBuilder = (
  task,
  previousOutput,
  index,
  _allPreviousOutputs
) => {
  if (index === 0) {
    return task.prompt;
  }
  return `${task.prompt}\n\n[Previous Output]\n${previousOutput}`;
};

/**
 * Runs a sequence of crew tasks one after another, chaining the outputs.
 * Spawns each task, polls its state every 50ms until settled, and uses its output
 * to construct the prompt for the next task.
 *
 * If any task fails or is killed, execution stops immediately, returning the
 * accumulated records and the error.
 *
 * If the task list is empty, returns success with no records or output.
 */
export async function runCrewSequentialProcess(
  manager: SwarmManager,
  tasks: readonly CrewTask[],
  promptBuilder: CrewPromptBuilder = defaultCrewPromptBuilder
): Promise<CrewSequentialResult> {
  if (tasks.length === 0) {
    return {
      success: true,
      records: []
    };
  }

  const records: SwarmTaskRecord[] = [];
  const allPreviousOutputs: string[] = [];

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const previousOutput = i === 0 ? "" : (allPreviousOutputs[i - 1] ?? "");
    const prompt = promptBuilder(task, previousOutput, i, allPreviousOutputs);
    const mode: SwarmWorkerMode = task.mode ?? "read-only";

    let record: SwarmTaskRecord;
    try {
      record = manager.spawn(prompt, mode, task.label);
    } catch (err) {
      return {
        success: false,
        records,
        error: err instanceof Error ? err.message : String(err)
      };
    }

    records.push(record);

    while (true) {
      const updated = manager.get(record.id);
      if (!updated) {
        break;
      }
      if (updated.state === "done" || updated.state === "failed" || updated.state === "killed") {
        break;
      }
      await sleep(50);
    }

    const finalRecord = manager.get(record.id) ?? record;
    if (finalRecord.state === "failed" || finalRecord.state === "killed") {
      return {
        success: false,
        records,
        error: finalRecord.error ?? `Task was ${finalRecord.state}.`
      };
    }

    const output = finalRecord.resultText ?? "";
    allPreviousOutputs.push(output);
  }

  const finalOutput = allPreviousOutputs[allPreviousOutputs.length - 1];
  if (finalOutput === undefined) {
    return {
      success: true,
      records
    };
  }

  return {
    success: true,
    records,
    finalOutput
  };
}
