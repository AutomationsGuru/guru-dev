export interface SpeculativeToolConfig {
  readonly executeTool: (toolId: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
  readonly getToolEffect: (toolId: string) => "read-only" | "mutating" | undefined;
  readonly mandatePolicy?: (
    toolId: string,
    input: unknown
  ) => { outcome: "allow" | "deny" | "escalate"; reason?: string } | null;
  readonly signal?: AbortSignal;
  readonly maxSpeculativeTools?: number;
}

export interface PartialToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText?: string;
  readonly arguments?: unknown;
}

interface SpeculativeExecution {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  completed: boolean;
  failed: boolean;
}

export class SpeculativeToolManager {
  private readonly config: SpeculativeToolConfig;
  private readonly executions = new Map<string, SpeculativeExecution>();
  private runningCount = 0;

  constructor(config: SpeculativeToolConfig) {
    this.config = config;

    if (config.signal) {
      if (config.signal.aborted) {
        // Parent signal is already aborted
      } else {
        config.signal.addEventListener("abort", () => {
          this.cancelAll();
        });
      }
    }
  }

  onPartialStream(
    toolCall: { id: string; name: string; argumentsText: string } | { id: string; name: string; arguments: unknown }
  ): Promise<unknown> | null {
    const { id, name: toolId } = toolCall;

    // 1. If we already have an execution for this tool call ID, return its promise
    const existing = this.executions.get(id);
    if (existing) {
      return existing.promise;
    }

    // 2. Parse arguments
    let input: unknown;
    if ("argumentsText" in toolCall && toolCall.argumentsText !== undefined) {
      try {
        input = JSON.parse(toolCall.argumentsText);
      } catch {
        // If JSON parsing fails, return null
        return null;
      }
    } else if ("arguments" in toolCall && toolCall.arguments !== undefined) {
      input = toolCall.arguments;
    } else {
      return null;
    }

    // 3. Classification logic: only speculatively execute "read-only" tools
    const effect = this.config.getToolEffect(toolId);
    if (effect !== "read-only") {
      return null;
    }

    // 4. Prevent execution of tools posing shell/exec risk
    const isShellOrBash = toolId === "bash" || toolId === "shell_exec" || /bash|shell|exec|run|cmd/i.test(toolId);
    if (isShellOrBash) {
      return null;
    }

    // 5. Hard limit: if max speculative tools reached, do not auto-start
    const maxSpeculative = this.config.maxSpeculativeTools ?? 3;
    if (this.runningCount >= maxSpeculative) {
      return null;
    }

    // 6. Evaluate mandatePolicy if provided
    if (this.config.mandatePolicy) {
      const policy = this.config.mandatePolicy(toolId, input);
      if (policy && policy.outcome !== "allow") {
        return null;
      }
    }

    // 7. Start speculative execution
    const controller = new AbortController();
    this.runningCount++;

    const promise = (async () => {
      try {
        const result = await this.config.executeTool(toolId, input, controller.signal);
        const exec = this.executions.get(id);
        if (exec) {
          exec.completed = true;
        }
        return result;
      } catch (err) {
        const exec = this.executions.get(id);
        if (exec) {
          exec.completed = true;
          exec.failed = true;
        }
        throw err;
      } finally {
        this.runningCount--;
      }
    })();

    const execution: SpeculativeExecution = {
      promise,
      controller,
      completed: false,
      failed: false
    };

    this.executions.set(id, execution);
    return promise;
  }

  cancel(id: string): void {
    const execution = this.executions.get(id);
    if (execution) {
      if (!execution.completed) {
        execution.controller.abort();
      }
      this.executions.delete(id);
    }
  }

  cancelAll(): void {
    for (const execution of this.executions.values()) {
      if (!execution.completed) {
        execution.controller.abort();
      }
    }
    this.executions.clear();
    this.runningCount = 0;
  }
}
