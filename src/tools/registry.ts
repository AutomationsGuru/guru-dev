import type { z, ZodType } from "zod";

import { sanitizeToolOutput } from "../safety/outputSanitizer.js";

export type ToolObservationStatus = "succeeded" | "failed";

export interface ToolExecutionContext {
  readonly runId?: string;
  readonly cwd?: string;
  readonly startedBy?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * The turn's abort signal (review 2026-07-08): forwarded from the agent loop so
   * a long-running tool (notably bash) can kill its child on operator cancel
   * instead of running to its own timeout. Optional — most tools ignore it.
   */
  readonly signal?: AbortSignal;
}

export interface ToolObservation<TOutput = unknown> {
  readonly toolId: string;
  readonly status: ToolObservationStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly output?: TOutput;
  readonly error?: string;
}

/**
 * Structural effect marker (G1004 plan-mode runtime gate). Declares whether a
 * tool only observes repository/process state (`"read-only"`) or mutates it
 * (`"mutating"`). Omission is untrusted: plan-mode certification accepts only
 * tools that explicitly declare `effect === "read-only"`, so an unmarked or
 * mutating definition is rejected even when a caller allowlists its id.
 */
export type ToolEffect = "read-only" | "mutating";

export interface ToolDefinition<TInputSchema extends ZodType = ZodType, TOutputSchema extends ZodType = ZodType> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly effect?: ToolEffect;
  execute(input: z.infer<TInputSchema>, context: ToolExecutionContext): Promise<z.infer<TOutputSchema>> | z.infer<TOutputSchema>;
}

export interface ToolRegistry {
  register<TInputSchema extends ZodType, TOutputSchema extends ZodType>(
    definition: ToolDefinition<TInputSchema, TOutputSchema>
  ): void;
  get(toolId: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
}

export function createToolRegistry(definitions: readonly ToolDefinition[] = []): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  const registry: ToolRegistry = {
    register(definition) {
      if (tools.has(definition.id)) {
        throw new Error(`Tool already registered: ${definition.id}`);
      }

      tools.set(definition.id, definition);
    },
    get(toolId) {
      return tools.get(toolId);
    },
    list() {
      return [...tools.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
  };

  for (const definition of definitions) {
    registry.register(definition);
  }

  return registry;
}

export async function executeRegisteredTool(
  registry: ToolRegistry,
  toolId: string,
  input: unknown,
  context: ToolExecutionContext = {}
): Promise<ToolObservation> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const definition = registry.get(toolId);

  if (!definition) {
    // Sanitize even here: toolId is model-supplied text (THERE v2 verification).
    return createFailedObservation(toolId, startedAtDate, sanitizeToolOutput(`Tool not registered: ${toolId}`));
  }

  const inputResult = definition.inputSchema.safeParse(input);

  if (!inputResult.success) {
    return createFailedObservation(
      toolId,
      startedAtDate,
      sanitizeToolOutput(inputResult.error.issues.map((issue) => formatSchemaIssue("input", issue.path, issue.message)).join("; "))
    );
  }

  try {
    const rawOutput = await definition.execute(inputResult.data, context);
    const outputResult = definition.outputSchema.safeParse(rawOutput);

    if (!outputResult.success) {
      return createFailedObservation(
        toolId,
        startedAtDate,
        // Custom Zod messages can echo output values — scrub this path too.
        sanitizeToolOutput(outputResult.error.issues.map((issue) => formatSchemaIssue("output", issue.path, issue.message)).join("; "))
      );
    }

    // THE render-layer secret sanitizer (ADR 2026-07-05, Legend System 6):
    // every tool's output passes through the shape+value scrub HERE, by
    // construction — no prompt, mode, or YOLO ritual can route around it.
    return createSucceededObservation(toolId, startedAtDate, sanitizeToolOutput(outputResult.data));
  } catch (error) {
    return createFailedObservation(toolId, startedAtDate, sanitizeToolOutput(formatError(error)));
  }
}

function createSucceededObservation<TOutput>(toolId: string, startedAtDate: Date, output: TOutput): ToolObservation<TOutput> {
  const endedAtDate = new Date();

  return {
    toolId,
    status: "succeeded",
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: Math.max(0, endedAtDate.getTime() - startedAtDate.getTime()),
    output
  };
}

function createFailedObservation(toolId: string, startedAtDate: Date, error: string): ToolObservation {
  const endedAtDate = new Date();

  return {
    toolId,
    status: "failed",
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: Math.max(0, endedAtDate.getTime() - startedAtDate.getTime()),
    error
  };
}

function formatSchemaIssue(scope: "input" | "output", path: PropertyKey[], message: string): string {
  const formattedPath = path.length > 0 ? path.join(".") : "root";

  return `Invalid ${scope} at ${formattedPath}: ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
