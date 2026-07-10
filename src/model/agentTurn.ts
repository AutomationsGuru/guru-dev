import { z } from "zod";

import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import type { ToolDefinition, ToolObservation } from "../tools/registry.js";
import { sanitizeErrorMessage } from "../router/health.js";
import { resolveProviderWire } from "./providerWire.js";
import {
  DEFAULT_RETRY_CONFIG,
  parseRetryAfterMs,
  runWithRetryPolicy,
  type RetryConfig,
  type RetryHooks
} from "./retryPolicy.js";
import {
  DirectChatError,
  isChatCapableFamily,
  resolveRouteCredential,
  type ChatTurnMessage,
  type DirectChatOptions,
  type DirectChatResult
} from "./directChat.js";

/**
 * Agentic turn loop: the model may call the harness's registered tools in a
 * bounded loop; tool results are fed back until the model produces a final answer.
 *
 * Families: openai-chat-completions (+ ollama), openai-responses, anthropic-messages.
 * Direct-first only — the route's own baseUrl, never the LiteLLM router.
 *
 * Safety: every call goes through the injected approval policy BEFORE execution.
 * Blocked calls return an explicit policy error to the model (never silently dropped).
 * Tool outputs are size-capped; credentials by env NAME only; errors are sanitized.
 */

export type HeaderStyle = "bearer" | "api-key" | "x-api-key";

/**
 * Provider-specific base composition: Azure endpoints are set as RESOURCE endpoints
 * (env names only); the API paths are composed here so operators never hand-build
 * URLs. azure-openai → {endpoint}/openai/v1 · azure-foundry → {endpoint}/models.
 */
/** Strip trailing `/` without a trailing-slash regex (CodeQL js/polynomial-redos). */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function adjustProviderBase(providerId: string, base: string): string {
  if (providerId.startsWith("azure")) {
    // Azure resource endpoints → exactly one /openai/v1 suffix.
    // Manual suffix strip (no backtracking regex on library-controlled base URLs).
    let trimmed = stripTrailingSlashes(base);
    const lower = trimmed.toLowerCase();
    if (lower.endsWith("/openai/v1")) {
      trimmed = trimmed.slice(0, -"/openai/v1".length);
    } else if (lower.endsWith("/openai")) {
      trimmed = trimmed.slice(0, -"/openai".length);
    }
    return `${stripTrailingSlashes(trimmed)}/openai/v1`;
  }
  return base;
}

const MAX_TOOL_OUTPUT_CHARS = 20000;
// 24: shakedown data — a small task took 8 calls; a multi-file repair took 10 on a
// terse model but 16/16 (budget exhausted before final verification) on a methodical
// reasoning model (sakana, 2026-07-02 cross-family run). Compact repo-context keeps
// per-iteration cost low enough that headroom beats truncation.
const DEFAULT_MAX_TOOL_CALLS = 24;

export interface AgentToolEvent {
  readonly toolId: string;
  readonly status: "blocked" | "succeeded" | "failed";
  readonly durationMs?: number;
  readonly detail?: string;
  /** Compact human hint of what was asked (command/path), for trace rendering. */
  readonly inputPreview?: string;
  /** First lines of the tool result, for trace rendering ("show me what it did"). */
  readonly outputPreview?: string;
}

export interface AgentTurnOptions extends DirectChatOptions {
  readonly tools: readonly ToolDefinition[];
  /**
   * Execute a tool. The optional signal (review 2026-07-08) carries the turn's
   * abort so a long-running tool (bash) can kill its child on operator cancel;
   * call sites that don't care about cancellation ignore it.
   */
  readonly executeTool: (toolId: string, input: unknown, signal?: AbortSignal) => Promise<ToolObservation>;
  /** Approval policy: return true to allow execution. Called for EVERY tool call. */
  readonly approveTool: (toolId: string, input: unknown) => boolean | Promise<boolean>;
  readonly onToolEvent?: (event: AgentToolEvent) => void;
  readonly maxToolCalls?: number;
  /**
   * Stream callback: assistant text chunks as the model generates them. When set,
   * requests SSE streaming; falls back to non-streaming (honestly, same result shape)
   * if the provider rejects the stream request.
   */
  readonly onToken?: (text: string) => void;
  /**
   * Fired when the model has REQUESTED an approved tool and the turn is about to
   * BLOCK on its result — the commit plane's dead time. The look-ahead engine
   * uses this to dispatch read-only scouts. Fire-and-forget; must not block.
   */
  readonly onToolPending?: (toolId: string, input: unknown) => void;
  /**
   * Retry policy for the underlying provider requests (ADR 2026-07-05): 429/5xx/
   * network failures back off exponentially; other 4xx fail immediately; a
   * Retry-After beyond the cap fails fast. Defaults to the standard policy.
   */
  readonly retry?: RetryConfig;
  /** Retry indicator callback: attempt N/M, delay, reason. */
  readonly onRetry?: RetryHooks["onRetry"];
  /** Test seams: injectable sleep + jitter source (deterministic suites). */
  readonly retrySleep?: RetryHooks["sleep"];
  readonly retryRandom?: RetryHooks["random"];
  /**
   * Abort a RUNNING turn (§17 scenario 13). Checked at each agentic-loop iteration
   * and linked to the in-flight request; on abort the loop returns the partial text
   * so far. Absent → no abort path (byte-identical to the plain loop).
   */
  readonly signal?: AbortSignal;
  /**
   * Mid-run steering (§17 scenario 13): called at the top of each loop iteration
   * (after the first tool round); any returned notes are injected into the running
   * conversation before the next model request. Absent → no injection.
   */
  readonly pullSteering?: () => readonly string[];
}

export interface AgentTurnResult extends DirectChatResult {
  readonly toolCallCount: number;
  readonly toolEvents: readonly AgentToolEvent[];
}

interface ToolDeclaration {
  readonly apiName: string;
  readonly toolId: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** OpenAI/Anthropic tool names allow [a-zA-Z0-9_-] only — map ids like repo.context.resolve. */
export function toApiToolName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/gu, "__");
}

const MAX_TOOL_DESCRIPTION_CHARS = 256;

export function buildToolDeclarations(tools: readonly ToolDefinition[]): readonly ToolDeclaration[] {
  return tools.map((tool) => ({
    apiName: toApiToolName(tool.id),
    toolId: tool.id,
    description: `${tool.title}. ${tool.description}`.slice(0, MAX_TOOL_DESCRIPTION_CHARS),
    parameters: stripSchemaNoise(zodToJsonSchema(tool.inputSchema))
  }));
}

/** Trim token-heavy noise from generated JSON schemas: long nested descriptions. */
function stripSchemaNoise(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string" && value.length > 160) {
          out[key] = `${value.slice(0, 157)}...`;
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    }
    return node;
  };

  return walk(schema) as Record<string, unknown>;
}

function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    const converted = z.toJSONSchema(schema as z.ZodType, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete converted.$schema;

    return converted;
  } catch {
    return { type: "object", properties: {}, additionalProperties: true };
  }
}

export async function directAgentTurn(
  route: ProviderRouteDescriptor,
  messages: readonly ChatTurnMessage[],
  options: AgentTurnOptions
): Promise<AgentTurnResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const apiFamily = route.apiFamily ?? "openai-chat-completions";
  const modelId = options.modelIdOverride ?? route.modelId;
  const maxTokens = options.maxTokens ?? 4096;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  if (!fetchImpl) {
    throw new DirectChatError("fetch is not available in this runtime.", { routeId: route.routeId });
  }
  if (!isChatCapableFamily(apiFamily)) {
    throw new DirectChatError(`API family '${apiFamily}' is not agent-capable in this slice.`, { routeId: route.routeId });
  }

  const credential = resolveRouteCredential(route, env);
  if (!credential.usable) {
    throw new DirectChatError(credential.reason, { routeId: route.routeId });
  }

  const baseUrl = (route.baseUrl?.startsWith("os.environ/") ? env[route.baseUrl.replace("os.environ/", "")] : route.baseUrl) ?? "";
  if (baseUrl.length === 0) {
    throw new DirectChatError("Route has no usable baseUrl.", { routeId: route.routeId });
  }
  const normalizedBase = adjustProviderBase(route.providerId, stripTrailingSlashes(baseUrl));
  const secretValue = credential.value ?? (credential.envName ? env[credential.envName] : undefined);
  const wire = resolveProviderWire(route, env);
  const headerStyle: HeaderStyle = wire.headerStyle;
  const extraHeaders: Record<string, string> = wire.extraHeaders;
  const bodyExtras: Record<string, unknown> = route.wire?.bodyExtras ?? {};
  const requireStreaming = route.wire?.requireStreaming === true;
  const omitMaxTokens = route.wire?.omitMaxTokens === true;
  const declarations = buildToolDeclarations(options.tools);
  const byApiName = new Map(declarations.map((declaration) => [declaration.apiName, declaration]));

  const context: FamilyContext = {
    fetchImpl,
    normalizedBase,
    headerStyle,
    extraHeaders,
    bodyExtras,
    requireStreaming,
    omitMaxTokens,
    secretValue,
    modelId,
    maxTokens,
    routeId: route.routeId,
    declarations,
    byApiName,
    approveTool: options.approveTool,
    executeTool: options.executeTool,
    onToolEvent: options.onToolEvent,
    onToken: options.onToken,
    onToolPending: options.onToolPending,
    signal: options.signal,
    pullSteering: options.pullSteering,
    streamingDisabled: false,
    useMaxCompletionTokens: false,
    maxToolCalls,
    events: [],
    usage: { input: 0, output: 0, lastRequestInput: 0 },
    retry: options.retry ?? DEFAULT_RETRY_CONFIG,
    retryHooks: {
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
      ...(options.retrySleep ? { sleep: options.retrySleep } : {}),
      ...(options.retryRandom ? { random: options.retryRandom } : {})
    }
  };

  let text: string;
  if (apiFamily === "anthropic-messages") {
    text = await runAnthropicLoop(context, messages);
  } else if (apiFamily === "openai-responses") {
    text = await runResponsesLoop(context, messages);
  } else {
    text = await runChatCompletionsLoop(context, messages);
  }

  return {
    text,
    modelId,
    routeId: route.routeId,
    apiFamily,
    ...(context.usage.input > 0 || context.usage.output > 0
      ? {
          usage: {
            inputTokens: context.usage.input,
            outputTokens: context.usage.output,
            // The final request's prompt size = the real context footprint
            // (input is the SUM across tool-loop iterations — do not conflate).
            lastRequestInputTokens: context.usage.lastRequestInput
          }
        }
      : {}),
    toolCallCount: context.events.filter((event) => event.status !== "blocked").length,
    toolEvents: context.events
  };
}

interface FamilyContext {
  readonly fetchImpl: typeof fetch;
  readonly normalizedBase: string;
  readonly headerStyle: HeaderStyle;
  readonly extraHeaders: Record<string, string>;
  readonly bodyExtras: Record<string, unknown>;
  /** Force streaming even without an onToken sink (codex-direct rejects non-stream). */
  readonly requireStreaming: boolean;
  /** Omit max_output_tokens from the Responses body (codex rejects it). Flipped on 400 evidence. */
  omitMaxTokens: boolean;
  readonly secretValue: string | undefined;
  readonly modelId: string;
  readonly maxTokens: number;
  readonly routeId: string;
  readonly declarations: readonly ToolDeclaration[];
  readonly byApiName: ReadonlyMap<string, ToolDeclaration>;
  readonly approveTool: (toolId: string, input: unknown) => boolean | Promise<boolean>;
  readonly executeTool: (toolId: string, input: unknown, signal?: AbortSignal) => Promise<ToolObservation>;
  readonly onToolEvent: ((event: AgentToolEvent) => void) | undefined;
  readonly onToken: ((text: string) => void) | undefined;
  readonly onToolPending: ((toolId: string, input: unknown) => void) | undefined;
  /** Abort a running turn (§17 S13): checked per iteration + linked to the fetch. */
  readonly signal: AbortSignal | undefined;
  /** Mid-run steering source (§17 S13): pulled at each iteration top after the first tool round. */
  readonly pullSteering: (() => readonly string[]) | undefined;
  /** Flipped when a provider rejects streaming — the rest of the turn goes non-streaming. */
  streamingDisabled: boolean;
  /** Some OpenAI-family models reject max_tokens; flipped on 400 evidence and retried. */
  useMaxCompletionTokens: boolean;
  readonly maxToolCalls: number;
  readonly events: AgentToolEvent[];
  readonly usage: { input: number; output: number; lastRequestInput: number };
  readonly retry: RetryConfig;
  readonly retryHooks: RetryHooks;
}

function wantsStreaming(context: FamilyContext): boolean {
  if (context.streamingDisabled) {
    return false;
  }
  // Some lanes (codex-direct) REJECT non-streaming requests — they must always
  // stream even when no onToken sink is attached (the stream is accumulated).
  return context.onToken !== undefined || context.requireStreaming;
}

/** Approval → execution → capped serialized result. Shared by all families. */
async function performToolCall(context: FamilyContext, apiName: string, rawArguments: unknown): Promise<string> {
  const declaration = context.byApiName.get(apiName);
  if (!declaration) {
    return JSON.stringify({ error: `Unknown tool: ${apiName}` });
  }

  const input = typeof rawArguments === "string" ? safeParseJson(rawArguments) : rawArguments ?? {};

  if (!(await context.approveTool(declaration.toolId, input))) {
    const event: AgentToolEvent = {
      toolId: declaration.toolId,
      status: "blocked",
      detail: "Blocked by approval policy — the operator declined this tool call."
    };
    context.events.push(event);
    context.onToolEvent?.(event);

    return JSON.stringify({
      error: "Tool call blocked by the harness approval policy (the operator declined it)."
    });
  }

  // Dead-time signal: approved and about to block on the tool result.
  context.onToolPending?.(declaration.toolId, input);
  const observation = await context.executeTool(declaration.toolId, input, context.signal);
  const inputPreview = buildInputPreview(input);
  const outputPreview = buildOutputPreview(observation.output);
  const dryRun = isDryRunObservation(observation.output);
  const event: AgentToolEvent = {
    toolId: declaration.toolId,
    status: observation.status === "succeeded" ? "succeeded" : "failed",
    durationMs: observation.durationMs,
    ...(dryRun
      ? { detail: DRY_RUN_TOOL_DETAIL }
      : observation.error
        ? { detail: sanitizeErrorMessage(observation.error) }
        : {}),
    ...(inputPreview !== undefined ? { inputPreview } : {}),
    ...(outputPreview !== undefined ? { outputPreview } : {})
  };
  context.events.push(event);
  context.onToolEvent?.(event);

  const payload = observation.status === "succeeded" ? observation.output ?? {} : { error: observation.error ?? "tool failed" };
  const serialized = JSON.stringify(payload);

  return serialized.length > MAX_TOOL_OUTPUT_CHARS
    ? `${serialized.slice(0, MAX_TOOL_OUTPUT_CHARS)}... [truncated ${serialized.length - MAX_TOOL_OUTPUT_CHARS} chars]`
    : serialized;
}

/** Operator-visible label when a tool returned a dry-run payload (bash default). */
const DRY_RUN_TOOL_DETAIL = "DRY RUN — not executed (approve workspace-write to run for real)";

function isDryRunObservation(output: unknown): boolean {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return record.dryRun === true && record.executed === false;
}

/** Human hint of the call: command line, path, or first short string field. */
function buildInputPreview(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const candidate =
    (typeof record.command === "string" && record.command) ||
    (Array.isArray(record.command) && record.command.join(" ")) ||
    (typeof record.path === "string" && record.path) ||
    (typeof record.targetPath === "string" && record.targetPath) ||
    undefined;
  const dryPrefix = record.dryRun === true ? "[dry-run] " : "";

  if (typeof candidate === "string" && candidate.length > 0) {
    return `${dryPrefix}${candidate.slice(0, 80)}`;
  }
  return dryPrefix.length > 0 ? dryPrefix.trim() : undefined;
}

/** First meaningful lines of the result — stdout/text/summary preferred over raw JSON. */
function buildOutputPreview(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  const record = typeof output === "object" ? (output as Record<string, unknown>) : {};
  const text =
    (typeof record.stdout === "string" && record.stdout.trim()) ||
    (typeof record.text === "string" && record.text.trim()) ||
    (typeof record.contents === "string" && record.contents.trim()) ||
    (typeof record.summary === "string" && record.summary.trim()) ||
    (typeof output === "string" ? output.trim() : "");
  if (text.length === 0) return undefined;
  const lines = text.split(/\r?\n/u);
  const shown = lines.slice(0, 3).map((line) => line.slice(0, 110));
  const remainder = lines.length - 3;

  return shown.join("\n") + (remainder > 0 ? `\n… +${remainder} more line(s)` : "");
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function toolCallBudgetExhaustedMessage(): string {
  return JSON.stringify({ error: "Tool-call budget exhausted for this turn. Answer with what you have." });
}

async function runChatCompletionsLoop(context: FamilyContext, messages: readonly ChatTurnMessage[]): Promise<string> {
  type OpenAiToolCall = { id: string; function: { name: string; arguments: string } };
  // Some OpenAI-compatible providers (Bedrock mantle, certain GLM builds) return
  // `message.content` as an ARRAY of {type:"text",text:...} blocks instead of a
  // string. Pushing that array back into the conversation makes the provider 400
  // on the next turn ("content must be a string"). Normalize to a string at the
  // boundary (review 2026-07-08).
  type ContentBlock = { type?: string; text?: string };
  const normalizeContent = (content: unknown): string => {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => (typeof block === "object" && block !== null ? String((block as ContentBlock).text ?? "") : ""))
        .join("");
    }
    return "";
  };
  const conversation: unknown[] = messages.map((message) => ({ role: message.role, content: message.content }));
  const tools = context.declarations.map((declaration) => ({
    type: "function",
    function: { name: declaration.apiName, description: declaration.description, parameters: declaration.parameters }
  }));

  let toolBudget = context.maxToolCalls;
  let lastAssistant = "";
  // Hard iteration cap: the budget bounds tool EXECUTIONS, but a model that keeps
  // requesting tools after exhaustion would otherwise loop forever (found by a
  // probe-harness fake that always returned tool calls).
  for (let iteration = 0; iteration < context.maxToolCalls + 4; iteration += 1) {
    // Abort checkpoint (§17 S13): stop between steps, returning the partial so far.
    if (context.signal?.aborted) {
      return lastAssistant;
    }
    // Mid-run steer (§17 S13): inject the operator's notes before the next request.
    if (iteration > 0 && context.pullSteering) {
      for (const note of context.pullSteering()) {
        conversation.push({ role: "user", content: `[steering] ${note}` });
      }
    }
    const body = {
      model: context.modelId,
      messages: conversation,
      ...(context.useMaxCompletionTokens ? { max_completion_tokens: context.maxTokens } : { max_tokens: context.maxTokens }),
      ...(tools.length > 0 ? { tools } : {})
    };
    let response: {
      choices?: Array<{ message?: { content?: string | null | ContentBlock[]; tool_calls?: OpenAiToolCall[] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      response = (wantsStreaming(context)
        ? await streamChatCompletions(context, body)
        : await postJson(context, "/chat/completions", body)) as typeof response;
    } catch (error) {
      // Auto-adapt the OpenAI param quirk: retry once with max_completion_tokens.
      const message = error instanceof Error ? error.message : String(error);
      if (!context.useMaxCompletionTokens && /max_completion_tokens/u.test(message)) {
        context.useMaxCompletionTokens = true;
        iteration -= 1;
        continue;
      }
      // Mid-stream failure after partial tokens — return what we have, don't torch the turn.
      if (lastAssistant.length > 0 && isTransientStreamError(error)) {
        return lastAssistant;
      }
      throw error;
    }
    context.usage.input += response.usage?.prompt_tokens ?? 0;
    context.usage.output += response.usage?.completion_tokens ?? 0;
    // Missing usage keeps the LAST KNOWN request size (never 0): within a turn that is the
    // honest lower bound, and under-reporting would DELAY compaction. Fresh per turn.
    context.usage.lastRequestInput = response.usage?.prompt_tokens ?? context.usage.lastRequestInput;

    const message = response.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    const assistantText = normalizeContent(message?.content);
    if (assistantText.length > 0) {
      lastAssistant = assistantText;
    }
    if (toolCalls.length === 0) {
      // Terminal turn: fall back to the last non-empty assistant text when the
      // final turn is empty (mirrors the anthropic loop fix, review 2026-07-08).
      return assistantText.length > 0 ? assistantText : lastAssistant;
    }

    // Push the NORMALIZED string content (never the raw array) so the next turn's
    // request is valid for every OpenAI-compatible provider (review 2026-07-08).
    conversation.push({ role: "assistant", content: assistantText || null, tool_calls: toolCalls });
    for (const toolCall of toolCalls) {
      const result =
        toolBudget > 0 ? await performToolCall(context, toolCall.function.name, toolCall.function.arguments) : toolCallBudgetExhaustedMessage();
      // Only a REAL (approved + executed) call consumes budget (review 2026-07-08).
      // A denied/blocked call returns an error string but pushes a "blocked" event;
      // counting those drained the budget invisibly and the model, told only
      // "blocked", would retry the same call and exhaust the loop early.
      const lastEvent = context.events[context.events.length - 1];
      if (lastEvent && lastEvent.status !== "blocked") {
        toolBudget -= 1;
      }
      conversation.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }
  throw new DirectChatError(`Agent loop exceeded the iteration cap (${context.maxToolCalls + 4}) without a final answer.`, { routeId: context.routeId });
}

async function runResponsesLoop(context: FamilyContext, messages: readonly ChatTurnMessage[]): Promise<string> {
  type ResponsesFunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };
  const input: unknown[] = messages.map((message) => ({ role: message.role, content: message.content }));
  const tools = context.declarations.map((declaration) => ({
    type: "function",
    name: declaration.apiName,
    description: declaration.description,
    parameters: declaration.parameters
  }));

  let toolBudget = context.maxToolCalls;
  let lastText = "";
  // Hard iteration cap: the budget bounds tool EXECUTIONS, but a model that keeps
  // requesting tools after exhaustion would otherwise loop forever (found by a
  // probe-harness fake that always returned tool calls).
  for (let iteration = 0; iteration < context.maxToolCalls + 4; iteration += 1) {
    if (context.signal?.aborted) {
      return lastText; // abort checkpoint (§17 S13)
    }
    if (iteration > 0 && context.pullSteering) {
      for (const note of context.pullSteering()) {
        input.push({ role: "user", content: `[steering] ${note}` });
      }
    }
    const body = {
      model: context.modelId,
      input,
      ...(context.omitMaxTokens ? {} : { max_output_tokens: context.maxTokens }),
      ...(tools.length > 0 ? { tools } : {}),
      ...context.bodyExtras
    };
    let response: {
      output_text?: string;
      output?: Array<
        | ResponsesFunctionCall
        | { type?: string; content?: Array<{ type?: string; text?: string }> }
      >;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      response = (wantsStreaming(context) ? await streamResponses(context, body) : await postJson(context, "/responses", body)) as typeof response;
    } catch (error) {
      // Auto-adapt: some Responses lanes reject max_output_tokens (codex-class quirks).
      const message = error instanceof Error ? error.message : String(error);
      if (!context.omitMaxTokens && /max_output_tokens/iu.test(message)) {
        context.omitMaxTokens = true;
        iteration -= 1;
        continue;
      }
      // Mid-stream failure after partial tokens — return what we have, don't torch the turn.
      if (lastText.length > 0 && isTransientStreamError(error)) {
        return lastText;
      }
      throw error;
    }
    context.usage.input += response.usage?.input_tokens ?? 0;
    context.usage.output += response.usage?.output_tokens ?? 0;
    // Missing usage keeps the last known request size — deliberate (see chat-completions site).
    context.usage.lastRequestInput = response.usage?.input_tokens ?? context.usage.lastRequestInput;

    const output = response.output ?? [];
    const functionCalls = output.filter((item): item is ResponsesFunctionCall => (item as { type?: string }).type === "function_call");
    const responseText =
      response.output_text ??
      output
        .flatMap((item) => ("content" in item ? item.content ?? [] : []))
        .filter((block) => block.type === "output_text" || block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
    if (responseText.length > 0) {
      lastText = responseText;
    }
    if (functionCalls.length === 0) {
      // Terminal turn: fall back to the last non-empty text when the final turn
      // is empty (mirrors the anthropic/chat-completions fix, review 2026-07-08).
      return responseText.length > 0 ? responseText : lastText;
    }

    for (const item of output) {
      input.push(item);
    }
    for (const functionCall of functionCalls) {
      const result =
        toolBudget > 0 ? await performToolCall(context, functionCall.name, functionCall.arguments) : toolCallBudgetExhaustedMessage();
      // Only a REAL (approved + executed) call consumes budget (review 2026-07-08).
      const lastEvent = context.events[context.events.length - 1];
      if (lastEvent && lastEvent.status !== "blocked") {
        toolBudget -= 1;
      }
      input.push({ type: "function_call_output", call_id: functionCall.call_id, output: result });
    }
  }
  throw new DirectChatError(`Agent loop exceeded the iteration cap (${context.maxToolCalls + 4}) without a final answer.`, { routeId: context.routeId });
}

async function runAnthropicLoop(context: FamilyContext, messages: readonly ChatTurnMessage[]): Promise<string> {
  type AnthropicBlock = { type: string; id?: string; name?: string; input?: unknown; text?: string };
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const conversation: unknown[] = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  const tools = context.declarations.map((declaration) => ({
    name: declaration.apiName,
    description: declaration.description,
    input_schema: declaration.parameters
  }));

  let toolBudget = context.maxToolCalls;
  let lastText = "";
  // Hard iteration cap: the budget bounds tool EXECUTIONS, but a model that keeps
  // requesting tools after exhaustion would otherwise loop forever (found by a
  // probe-harness fake that always returned tool calls).
  for (let iteration = 0; iteration < context.maxToolCalls + 4; iteration += 1) {
    if (context.signal?.aborted) {
      return lastText; // abort checkpoint (§17 S13)
    }
    // Mid-run steer: append to the last user (tool_result) message so anthropic's
    // strict user/assistant alternation is preserved (never a second user in a row).
    if (iteration > 0 && context.pullSteering) {
      const notes = context.pullSteering();
      const last = conversation[conversation.length - 1] as { role?: string; content?: unknown } | undefined;
      if (notes.length > 0 && last?.role === "user" && Array.isArray(last.content)) {
        for (const note of notes) {
          (last.content as unknown[]).push({ type: "text", text: `[steering] ${note}` });
        }
      }
    }
    const body = {
      model: context.modelId,
      max_tokens: context.maxTokens,
      ...(system.length > 0 ? { system } : {}),
      messages: conversation,
      ...(tools.length > 0 ? { tools } : {})
    };
    const anthropicHeaders = {
      "anthropic-version": "2023-06-01",
      // Honor each declared HeaderStyle explicitly (review 2026-07-08): the old
      // ternary mapped bearer → authorization and EVERYTHING ELSE → x-api-key,
      // silently rewriting a lane configured `api-key` style (valid per the
      // HeaderStyle union) into x-api-key, which 401s cryptically.
      ...(context.secretValue
        ? context.headerStyle === "bearer"
          ? { authorization: `Bearer ${context.secretValue}` }
          : context.headerStyle === "api-key"
            ? { "api-key": context.secretValue }
            : { "x-api-key": context.secretValue }
        : {}),
      ...context.extraHeaders
    };
    let response: {
      content?: AnthropicBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      response = (wantsStreaming(context)
        ? await streamAnthropicMessages(context, body, anthropicHeaders)
        : await postJson(context, "/v1/messages", body, anthropicHeaders, false)) as typeof response;
    } catch (error) {
      // Mid-stream failure after partial tokens — keep the partial, don't torch the turn.
      if (lastText.length > 0 && isTransientStreamError(error)) {
        return lastText;
      }
      throw error;
    }
    context.usage.input += response.usage?.input_tokens ?? 0;
    context.usage.output += response.usage?.output_tokens ?? 0;
    // Missing usage keeps the last known request size — deliberate (see chat-completions site).
    context.usage.lastRequestInput = response.usage?.input_tokens ?? context.usage.lastRequestInput;

    const blocks = response.content ?? [];
    const toolUses = blocks.filter((block) => block.type === "tool_use");
    const blockText = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (blockText.length > 0) {
      lastText = blockText;
    }
    if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
      // Terminal turn. A common Claude pattern emits the real answer as text on
      // the tool-requesting turn ("Let me read foo.txt" + tool_use), then ends
      // on a later turn with empty text. Returning blockText alone gave the user
      // an empty reply even though lastText holds the answer (review 2026-07-08).
      return blockText.length > 0 ? blockText : lastText;
    }

    conversation.push({ role: "assistant", content: blocks });
    const results: unknown[] = [];
    for (const toolUse of toolUses) {
      const result =
        toolBudget > 0 ? await performToolCall(context, toolUse.name ?? "", toolUse.input ?? {}) : toolCallBudgetExhaustedMessage();
      // Only a REAL (approved + executed) call consumes budget (review 2026-07-08).
      const lastEvent = context.events[context.events.length - 1];
      if (lastEvent && lastEvent.status !== "blocked") {
        toolBudget -= 1;
      }
      results.push({ type: "tool_result", tool_use_id: toolUse.id ?? "", content: result });
    }
    conversation.push({ role: "user", content: results });
  }
  throw new DirectChatError(`Agent loop exceeded the iteration cap (${context.maxToolCalls + 4}) without a final answer.`, { routeId: context.routeId });
}

// ---------------------------------------------------------------------------
// SSE streaming: each stream* function requests server-sent events, emits text
// chunks through context.onToken, and RECONSTRUCTS the same response shape the
// non-streaming path returns — so the tool-loop logic above is identical either
// way. If the provider rejects the stream request (HTTP error), streaming is
// disabled for the rest of the turn and the same request is retried non-streaming.
// ---------------------------------------------------------------------------

interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

/** Compose operator abort + per-request timeout into one signal for fetch. */
function composeRequestSignal(operator: AbortSignal | undefined, timeoutMs: number | undefined): {
  readonly signal: AbortSignal | undefined;
  readonly disarm: () => void;
} {
  const parts: AbortSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (operator) {
    parts.push(operator);
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    // Don't pin the event loop (or vitest workers) for the full timeout window.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    parts.push(controller.signal);
  }
  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  if (parts.length === 0) {
    return { signal: undefined, disarm };
  }
  if (parts.length === 1) {
    return { signal: parts[0], disarm };
  }
  // AbortSignal.any is Node 20+ / modern runtimes (engines >= 22).
  return { signal: AbortSignal.any(parts), disarm };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|abort/iu.test(message);
}

/** Network/reset mid-stream — safe to surface partial text instead of hard-fail. */
function isTransientStreamError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }
  if (error instanceof DirectChatError) {
    const annotated = error as DirectChatError & { networkFailure?: boolean; aborted?: boolean };
    return annotated.networkFailure === true || annotated.aborted === true;
  }
  return false;
}

async function* sseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      if (signal?.aborted) {
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(raw);
        if (parsed) {
          yield parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (!signal?.aborted) {
      const tail = parseSseEvent(buffer);
      if (tail) {
        yield tail;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseSseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/u);
  let event: string | undefined;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).trimStart());
    }
  }
  if (dataParts.length === 0) {
    return null;
  }
  return { ...(event !== undefined ? { event } : {}), data: dataParts.join("\n") };
}

async function openSseResponse(
  context: FamilyContext,
  path: string,
  body: unknown,
  headerOverride?: Record<string, string>,
  useBearer = true
): Promise<Response | null> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(useBearer && context.secretValue
      ? context.headerStyle === "bearer"
        ? { authorization: `Bearer ${context.secretValue}` }
        : context.headerStyle === "api-key"
          ? { "api-key": context.secretValue }
          : { "x-api-key": context.secretValue }
      : {}),
    ...context.extraHeaders,
    ...(headerOverride ?? {})
  };
  const url = `${context.normalizedBase}${path}`;

  // A lane that REQUIRES streaming cannot fall back to non-stream — it gets the
  // full retry policy on the streaming request itself (429/5xx/network back off;
  // other 4xx surface the real streaming error). Ordinary lanes keep the instant
  // fall-back-to-non-streaming below: the non-stream retry they fall back to
  // carries the policy already, so retrying here too would double-retry.
  if (context.requireStreaming) {
    const { response } = await fetchWithPolicy(context, url, headers, body, "Streaming request");
    return response;
  }

  // Operator abort + timeout bound TIME-TO-HEADERS on the SSE open. A blackholed
  // connection must not hang forever; an operator cancel must reach the fetch.
  // No retry loop here: abort/timeout lands in the catch below, which falls back
  // to the policy-carrying non-streaming path (unless the operator cancelled).
  const timeoutMs = context.retry.provider.timeoutMs;
  const { signal, disarm } = composeRequestSignal(context.signal, timeoutMs);
  let response: Response;
  try {
    response = await context.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    disarm();
    // Operator cancel is not a "try non-streaming" event — rethrow so the turn stops.
    if (context.signal?.aborted) {
      throw annotateForRetry(
        new DirectChatError(`Streaming request aborted: ${sanitizeErrorMessage(error)}`, { routeId: context.routeId }),
        { aborted: true }
      );
    }
    // Per-request timeout: don't fall through to a non-stream retry (it would just
    // wait out the same timeout again). Surface it honestly as a terminal timeout.
    if (isAbortError(error)) {
      throw annotateForRetry(
        new DirectChatError(`Streaming request timed out after ${context.retry.provider.timeoutMs}ms (retry.provider.timeoutMs).`, { routeId: context.routeId }),
        { timeout: true }
      );
    }
    // Network-level failure on the streaming request (DNS blip, reset socket).
    // Don't kill the turn: disable streaming and let the caller retry the identical
    // request non-streaming. If the network is truly down, that retry raises its own
    // honest error.
    context.streamingDisabled = true;
    return null;
  } finally {
    disarm(); // headers arrived; the stream body stays open by design
  }

  if (!response.ok) {
    // Distinguish "provider doesn't support streaming" (a fallback case) from a
    // real request error (review 2026-07-08). A 405/415/501 on `stream:true` often
    // means the endpoint rejects SSE — fall back to non-streaming. But a 401/403
    // (auth) or 400/404 (bad model/path/URL) is a genuine request error: falling
    // back would silently re-send the identical bad request, doubling latency and
    // rate-limit hits while obscuring the real first error. Surface those now.
    const status = response.status;
    const isStreamingUnsupported = status === 405 || status === 415 || status === 501 || status === 502;
    if (!isStreamingUnsupported) {
      const detail = await response.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw annotateForRetry(
        new DirectChatError(`Streaming request failed with HTTP ${status}: ${sanitizeErrorMessage(detail).slice(0, 300)}`, {
          routeId: context.routeId,
          status
        }),
        { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
      );
    }
    // Provider rejected streaming — disable streaming and let the caller retry the
    // identical request non-streaming. Honest fallback, not fake.
    context.streamingDisabled = true;
    return null;
  }

  return response;
}

async function streamChatCompletions(context: FamilyContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await openSseResponse(context, "/chat/completions", { ...body, stream: true });
  if (!response) {
    return postJson(context, "/chat/completions", body);
  }

  interface ToolCallAcc {
    id: string;
    name: string;
    argumentsText: string;
  }
  let text = "";
  const toolCalls = new Map<number, ToolCallAcc>();
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

  for await (const event of sseEvents(response, context.signal)) {
    if (event.data === "[DONE]") {
      break;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(event.data) as unknown;
    } catch {
      continue;
    }
    const parsed = chunk as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (parsed.usage) {
      usage = parsed.usage;
    }
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) {
      continue;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      text += delta.content;
      context.onToken?.(delta.content);
    }
    for (const toolDelta of delta.tool_calls ?? []) {
      const index = toolDelta.index ?? 0;
      const acc = toolCalls.get(index) ?? { id: "", name: "", argumentsText: "" };
      if (toolDelta.id) {
        acc.id = toolDelta.id;
      }
      if (toolDelta.function?.name) {
        acc.name += toolDelta.function.name;
      }
      if (toolDelta.function?.arguments) {
        acc.argumentsText += toolDelta.function.arguments;
      }
      toolCalls.set(index, acc);
    }
  }

  const toolCallList = [...toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    // type:"function" is required when this reconstructed message is echoed back in
    // the next loop iteration — several providers (e.g. GLM error 1214) reject
    // assistant tool_calls without it.
    .map(([, acc]) => ({ id: acc.id, type: "function", function: { name: acc.name, arguments: acc.argumentsText } }));

  return {
    choices: [
      {
        message: {
          content: text.length > 0 ? text : null,
          ...(toolCallList.length > 0 ? { tool_calls: toolCallList } : {})
        }
      }
    ],
    ...(usage ? { usage } : {})
  };
}

async function streamResponses(context: FamilyContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await openSseResponse(context, "/responses", { ...body, stream: true });
  if (!response) {
    return postJson(context, "/responses", body);
  }

  let completed: unknown = null;
  let streamedText = "";

  for await (const event of sseEvents(response, context.signal)) {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch {
      continue;
    }
    const typed = payload as { type?: string; delta?: string; response?: unknown };
    const kind = event.event ?? typed.type;
    if (kind === "response.output_text.delta" && typeof typed.delta === "string") {
      streamedText += typed.delta;
      context.onToken?.(typed.delta);
    } else if (kind === "response.completed" && typed.response !== undefined) {
      completed = typed.response;
    } else if (kind === "response.failed") {
      throw new DirectChatError("Agent stream reported response.failed.", { routeId: context.routeId });
    }
  }

  if (completed !== null) {
    // Some backends (codex) emit the text ONLY via output_text.delta events and
    // send a response.completed whose `output` array is empty. Backfill the
    // accumulated streamed text so the caller's extraction isn't left empty.
    if (streamedText.length > 0) {
      const record = completed as { output_text?: unknown; output?: unknown[] };
      const hasText =
        typeof record.output_text === "string" && record.output_text.length > 0
          ? true
          : Array.isArray(record.output) && record.output.length > 0;
      if (!hasText) {
        return { ...(completed as object), output_text: streamedText };
      }
    }
    return completed;
  }
  // Stream ended without a completed event — return what streamed as plain text,
  // with a rough output-token estimate so the turn's usage isn't zeroed (review
  // 2026-07-08). The compaction TRIGGER (lastRequestInput) is already preserved
  // upstream via the `?? context.usage.lastRequestInput` fallback; this keeps the
  // cumulative output count honest instead of silently under-reporting.
  return { output_text: streamedText, usage: { input_tokens: 0, output_tokens: Math.ceil(streamedText.length / 4) } };
}

async function streamAnthropicMessages(
  context: FamilyContext,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<unknown> {
  const response = await openSseResponse(context, "/v1/messages", { ...body, stream: true }, headers, false);
  if (!response) {
    return postJson(context, "/v1/messages", body, headers, false);
  }

  interface BlockAcc {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    inputJson?: string;
  }
  const blocks = new Map<number, BlockAcc>();
  let stopReason: string | undefined;
  const usage: { input_tokens?: number; output_tokens?: number } = {};

  for await (const event of sseEvents(response, context.signal)) {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch {
      continue;
    }
    const typed = payload as {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string; text?: string };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      message?: { usage?: { input_tokens?: number } };
      usage?: { output_tokens?: number };
    };
    const kind = event.event ?? typed.type;

    if (kind === "message_start" && typed.message?.usage?.input_tokens !== undefined) {
      usage.input_tokens = typed.message.usage.input_tokens;
    } else if (kind === "content_block_start" && typed.index !== undefined && typed.content_block) {
      blocks.set(typed.index, {
        type: typed.content_block.type ?? "text",
        ...(typed.content_block.id !== undefined ? { id: typed.content_block.id } : {}),
        ...(typed.content_block.name !== undefined ? { name: typed.content_block.name } : {}),
        text: typed.content_block.text ?? "",
        inputJson: ""
      });
    } else if (kind === "content_block_delta" && typed.index !== undefined && typed.delta) {
      const acc = blocks.get(typed.index);
      if (acc) {
        if (typed.delta.type === "text_delta" && typeof typed.delta.text === "string") {
          acc.text = (acc.text ?? "") + typed.delta.text;
          context.onToken?.(typed.delta.text);
        } else if (typed.delta.type === "input_json_delta" && typeof typed.delta.partial_json === "string") {
          acc.inputJson = (acc.inputJson ?? "") + typed.delta.partial_json;
        }
      }
    } else if (kind === "message_delta") {
      if (typed.delta?.stop_reason) {
        stopReason = typed.delta.stop_reason;
      }
      if (typed.usage?.output_tokens !== undefined) {
        usage.output_tokens = typed.usage.output_tokens;
      }
    }
  }

  const content = [...blocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, acc]) =>
      acc.type === "tool_use"
        ? { type: "tool_use", id: acc.id ?? "", name: acc.name ?? "", input: safeParseJson(acc.inputJson ?? "{}") }
        : { type: "text", text: acc.text ?? "" }
    );

  return {
    content,
    ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    usage
  };
}


/** Retry annotations carried on thrown DirectChatErrors (request-level only). */
interface RetryAnnotated {
  networkFailure?: boolean;
  retryAfterMs?: number;
  /** Operator/session abort — never retry. */
  aborted?: boolean;
  /** Per-request timeout fired — terminal (retrying waits out the same timeout again). */
  timeout?: boolean;
}

function annotateForRetry(error: DirectChatError, annotation: RetryAnnotated): DirectChatError {
  Object.assign(error, annotation);
  return error;
}

/** Maps a thrown request error onto the retry policy's failure shape. */
function describeRequestFailure(error: unknown): {
  status?: number;
  networkError?: boolean;
  retryAfterMs?: number;
  aborted?: boolean;
  timeout?: boolean;
} {
  if (error instanceof DirectChatError) {
    const annotated = error as DirectChatError & RetryAnnotated;
    return {
      ...(error.details.status !== undefined ? { status: error.details.status } : {}),
      ...(annotated.networkFailure === true ? { networkError: true } : {}),
      ...(annotated.retryAfterMs !== undefined ? { retryAfterMs: annotated.retryAfterMs } : {}),
      ...(annotated.aborted === true ? { aborted: true } : {}),
      ...(annotated.timeout === true ? { timeout: true } : {})
    };
  }
  if (error && typeof error === "object") {
    const e = error as { aborted?: boolean; timeout?: boolean };
    if (e.aborted === true) {
      return { aborted: true };
    }
    if (e.timeout === true) {
      return { timeout: true };
    }
  }
  return {};
}

/**
 * One provider request with the ADR 2026-07-05 policy: default per-request
 * timeout (retry.provider.timeoutMs), operator abort composed into fetch,
 * network failures marked retryable, aborts never retried, Retry-After parsed
 * off non-ok responses for the backoff/fail-fast decision.
 *
 * `readBody: true` (non-streaming callers) consumes the body INSIDE the attempt
 * so the timeout covers the whole read — headers-then-hang can't stall the turn
 * (review 2026-07-05). Streaming callers keep the body open; their timer
 * disarms at headers (a stream is SUPPOSED to stay open past any timeout).
 */
async function fetchWithPolicy(
  context: FamilyContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  failurePrefix: string,
  readBody = false
): Promise<{ response: Response; bodyText?: string }> {
  return runWithRetryPolicy(
    async () => {
      const timeoutMs = context.retry.provider.timeoutMs;
      const { signal, disarm } = composeRequestSignal(context.signal, timeoutMs);
      let response: Response;
      try {
        response = await context.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(signal ? { signal } : {})
        });
      } catch (error) {
        disarm();
        // Operator cancel: never retry.
        if (context.signal?.aborted) {
          throw annotateForRetry(
            new DirectChatError(`${failurePrefix} aborted: ${sanitizeErrorMessage(error)}`, { routeId: context.routeId }),
            { aborted: true }
          );
        }
        // Per-request timeout (review 2026-07-08): the timeout fires a SEPARATE
        // AbortController (composeRequestSignal), so context.signal is not set.
        // An abort-style error here with no operator abort means the TIMEOUT
        // fired — and retrying just waits out the same timeout again (3× = a
        // multi-minute hang on a blackholed route). Treat it as terminal, not
        // retryable: annotate with neither networkFailure nor aborted, and tag
        // it so the error message can say "timed out" instead of "request failed".
        if (isAbortError(error)) {
          throw annotateForRetry(
            new DirectChatError(`${failurePrefix} timed out after ${context.retry.provider.timeoutMs}ms (retry.provider.timeoutMs).`, { routeId: context.routeId }),
            { timeout: true }
          );
        }
        // Genuine network failure (DNS, reset, connection refused): retryable.
        throw annotateForRetry(
          new DirectChatError(`${failurePrefix} request failed: ${sanitizeErrorMessage(error)}`, { routeId: context.routeId }),
          { networkFailure: true }
        );
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        disarm();
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        throw annotateForRetry(
          new DirectChatError(`${failurePrefix} failed with HTTP ${response.status}: ${sanitizeErrorMessage(detail).slice(0, 300)}`, {
            routeId: context.routeId,
            status: response.status
          }),
          { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
        );
      }
      if (!readBody) {
        disarm();
        return { response };
      }
      try {
        const bodyText = await response.text();
        disarm();
        return { response, bodyText };
      } catch (error) {
        disarm();
        if (context.signal?.aborted) {
          throw annotateForRetry(
            new DirectChatError(`${failurePrefix} body read aborted: ${sanitizeErrorMessage(error)}`, { routeId: context.routeId }),
            { aborted: true }
          );
        }
        // Body read stalled/aborted after 200 headers — transient, retryable.
        throw annotateForRetry(
          new DirectChatError(`${failurePrefix} body read failed: ${sanitizeErrorMessage(error)}`, { routeId: context.routeId }),
          { networkFailure: true }
        );
      }
    },
    {
      config: context.retry,
      describeFailure: describeRequestFailure,
      hooks: context.retryHooks,
      ...(context.signal ? { signal: context.signal } : {})
    }
  );
}

async function postJson(
  context: FamilyContext,
  path: string,
  body: unknown,
  headerOverride?: Record<string, string>,
  useBearer = true
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(useBearer && context.secretValue
      ? context.headerStyle === "bearer"
        ? { authorization: `Bearer ${context.secretValue}` }
        : context.headerStyle === "api-key"
          ? { "api-key": context.secretValue }
          : { "x-api-key": context.secretValue }
      : {}),
    ...context.extraHeaders,
    ...(headerOverride ?? {})
  };
  const url = `${context.normalizedBase}${path}`;

  const { bodyText } = await fetchWithPolicy(context, url, headers, body, "Agent turn", true);

  const text = bodyText ?? "";
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = text;
  }

  return parsed;
}
