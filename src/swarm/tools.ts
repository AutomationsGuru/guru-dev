import {
  KillTaskInputSchema,
  SpawnAgentInputSchema,
  SpawnAgentResultSchema,
  TaskOutputInputSchema,
  TaskOutputResultSchema
} from "./schema.js";
import type { SwarmManager } from "./manager.js";
import type { ToolDefinition } from "../tools/registry.js";

/**
 * The swarm's model-facing trio (grok's reference surface), registered through
 * the extension host. spawn_agent returns IMMEDIATELY with a task id — the
 * parent's reasoning is the workflow (directive #3): spawn, keep working, poll
 * get_task_output when the results matter.
 */
export interface SwarmToolFactoryOptions {
  readonly manager: SwarmManager;
}

export function createSwarmTools(options: SwarmToolFactoryOptions): readonly ToolDefinition[] {
  const { manager } = options;

  const spawnTool: ToolDefinition<typeof SpawnAgentInputSchema, typeof SpawnAgentResultSchema> = {
    id: "spawn_agent",
    title: "Spawn a subagent",
    description:
      "Send out a bounded worker agent on the connected model to do a job in parallel (read-only scout by default; mode:'all' shares the session's live approval policy). Returns a taskId immediately — continue working and poll get_task_output.",
    inputSchema: SpawnAgentInputSchema,
    outputSchema: SpawnAgentResultSchema,
    execute: (input) => {
      // depth threads the recursion cap through the swarm: a worker spawning a
      // worker passes its own depth + 1. The harness's depth comes from the parent
      // turn context; when absent (parent session spawning top-level) we default 0.
      // manager.spawn fires SwarmDepthExceededError past maxSpawnDepth.
      const record = manager.spawn(input.prompt, input.mode, input.label, {
        ...(input.depth !== undefined ? { depth: input.depth } : {})
      });
      return {
        taskId: record.id,
        state: record.state,
        summary: `Worker ${record.id} (${record.mode}) ${record.state} — ${manager.effectiveConcurrency()} concurrent max. Poll get_task_output.`
      };
    }
  };

  const outputTool: ToolDefinition<typeof TaskOutputInputSchema, typeof TaskOutputResultSchema> = {
    id: "get_task_output",
    title: "Get a subagent's output",
    description: "Fetch a spawned worker's state and result text (done/failed/killed/running/queued).",
    inputSchema: TaskOutputInputSchema,
    outputSchema: TaskOutputResultSchema,
    execute: (input) => {
      const record = manager.get(input.taskId);
      if (!record) {
        return { found: false, summary: `No task '${input.taskId}'.` };
      }
      return {
        found: true,
        state: record.state,
        label: record.label,
        ...(record.resultText !== undefined ? { resultText: record.resultText } : {}),
        ...(record.error !== undefined ? { error: record.error } : {}),
        toolCallCount: record.toolCallCount,
        ...(record.budgetExceeded ? { budgetExceeded: true } : {}),
        summary: `Task ${record.id} (${record.label}): ${record.state}${record.budgetExceeded ? " · budget_exceeded (partial output)" : ""}${record.state === "running" || record.state === "queued" ? " — poll again shortly" : ""}.`
      };
    }
  };

  const killTool: ToolDefinition<typeof KillTaskInputSchema, typeof SpawnAgentResultSchema> = {
    id: "kill_task",
    title: "Kill a subagent",
    description: "Mark a spawned worker killed (mark-and-detach: a queued worker never starts; a running worker's result is discarded).",
    inputSchema: KillTaskInputSchema,
    outputSchema: SpawnAgentResultSchema,
    execute: (input) => {
      const record = manager.kill(input.taskId);
      return record
        ? { taskId: record.id, state: record.state, summary: `Task ${record.id} ${record.state}.` }
        : { taskId: input.taskId, state: "failed", summary: `No task '${input.taskId}'.` };
    }
  };

  return [spawnTool, outputTool, killTool];
}
