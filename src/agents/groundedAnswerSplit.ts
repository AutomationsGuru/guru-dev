/**
 * Grounded Answer Split
 *
 * Splits agent reasoning into two phases:
 * - Gatherer: May call tools to collect information
 * - Presenter: Answers from tool results only, without tool access
 *
 * This prevents hallucination by ensuring the final answer is grounded
 * in actual tool outputs rather than model imagination.
 */

import { directAgentTurn, type AgentTurnResult, type AgentTurnOptions } from "../model/agentTurn.js";

/**
 * Tool definition shape compatible with directAgentTurn.
 * (Defined locally to avoid cross-module dependency on a not-yet-materialized types module.)
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface GroundedAnswerSplitOptions {
  readonly question: string;
  readonly tools: readonly ToolDefinition[];
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface GroundedAnswerSplitResult {
  readonly gathererResult: AgentTurnResult;
  readonly presenterResult: AgentTurnResult;
  readonly finalAnswer: string;
}

/**
 * Execute a grounded answer split.
 *
 * Phase 1 (Gather): The gatherer receives the question and may use tools
 * to collect information. All tool calls and results are captured.
 *
 * Phase 2 (Present): The presenter receives the original question plus
 * the gatherer's tool results, but has NO tools available. It must answer
 * solely from the provided information.
 *
 * @param options Configuration for the split execution
 * @returns Both phase results and the final grounded answer
 */
export async function groundedAnswerSplit(
  options: GroundedAnswerSplitOptions
): Promise<GroundedAnswerSplitResult> {
  const { question, tools, provider, model, temperature, maxTokens, signal } = options;

  // Phase 1: Gatherer collects information using tools
  const gathererMessages = [
    {
      role: "user" as const,
      content: question,
    },
  ];

  const gathererOptions: AgentTurnOptions = {
    messages: gathererMessages,
    tools: [...tools],
    provider,
    model,
    temperature,
    maxTokens,
    signal,
  };

  const gathererResult = await directAgentTurn(gathererOptions);

  // Extract tool results for the presenter context
  const toolResultsContext = extractToolResultsContext(gathererResult);

  // Phase 2: Presenter answers from gathered results only (no tools)
  const presenterMessages = [
    {
      role: "system" as const,
      content:
        "You are a presenter. You must answer the user's question using ONLY the information provided below from tool results. " +
        "If the information needed to answer is not present, state that you do not have enough information. " +
        "Do not invent, assume, or hallucinate any facts. Do not call any tools.",
    },
    {
      role: "user" as const,
      content: question,
    },
    {
      role: "assistant" as const,
      content: `Tool results from gatherer:\n\n${toolResultsContext}`,
    },
  ];

  const presenterOptions: AgentTurnOptions = {
    messages: presenterMessages,
    tools: [], // No tools for presenter - must answer from context only
    provider,
    model,
    temperature,
    maxTokens,
    signal,
  };

  const presenterResult = await directAgentTurn(presenterOptions);

  const finalAnswer = presenterResult.finalMessage?.content ?? "";

  return {
    gathererResult,
    presenterResult,
    finalAnswer,
  };
}

/**
 * Extract a human-readable context string from the gatherer's tool events.
 */
function extractToolResultsContext(result: AgentTurnResult): string {
  if (!result.toolEvents || result.toolEvents.length === 0) {
    return "(No tool calls were made)";
  }

  const lines: string[] = [];
  for (const event of result.toolEvents) {
    lines.push(`Tool: ${event.toolName}`);
    if (event.result !== undefined) {
      const resultStr =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2);
      lines.push(`Result: ${resultStr}`);
    }
    if (event.error) {
      lines.push(`Error: ${event.error}`);
    }
    lines.push("---");
  }

  return lines.join("\n");
}
