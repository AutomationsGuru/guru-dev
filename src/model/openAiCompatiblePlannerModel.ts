import { PlannerPlanSchema, type PlannerModelRequest, type PlannerPlan } from "../planner/schemas.js";
import type { PlannerModel } from "../planner/runtime.js";
import { OpenAiCompatiblePlannerModelConfigSchema, type OpenAiCompatiblePlannerModelConfig } from "./schemas.js";

export interface PlannerModelFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type PlannerModelFetch = (url: string, init: RequestInit) => Promise<PlannerModelFetchResponse>;

export interface CreateOpenAiCompatiblePlannerModelOptions {
  readonly config: OpenAiCompatiblePlannerModelConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: PlannerModelFetch;
}

interface ChatCompletionResponse {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string | null;
    };
  }>;
}

const PLANNER_SYSTEM_PROMPT = [
  "You are the GuruHarness planner.",
  "Return only JSON that matches this shape:",
  "{\"objective\": string, \"summary\": string, \"steps\": [{\"id\": string, \"title\": string, \"toolId\": string, \"input\": object}]}",
  "Use only tool ids listed in the request. Keep steps minimal and ordered. Use an empty steps array when no tool is needed."
].join("\n");

export function createOpenAiCompatiblePlannerModel(options: CreateOpenAiCompatiblePlannerModelOptions): PlannerModel {
  const config = OpenAiCompatiblePlannerModelConfigSchema.parse(options.config);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async createPlan(request: PlannerModelRequest): Promise<PlannerPlan> {
      const apiKey = env[config.apiKeyEnvVar];

      if (!apiKey) {
        throw new Error(`Planner model API key env var is not set: ${config.apiKeyEnvVar}`);
      }

      const response = await fetchImpl(buildChatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: PLANNER_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(toPlannerPromptPayload(request)) }
          ]
        }),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Planner model request failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`);
      }

      return parsePlannerPlanResponse(responseText);
    }
  };
}

export function createPlannerModelFromConfig(
  config: OpenAiCompatiblePlannerModelConfig | undefined,
  options: Omit<CreateOpenAiCompatiblePlannerModelOptions, "config"> = {}
): PlannerModel | undefined {
  return config ? createOpenAiCompatiblePlannerModel({ ...options, config }) : undefined;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");

  return `${normalizedBaseUrl}/chat/completions`;
}

function toPlannerPromptPayload(request: PlannerModelRequest) {
  return {
    objective: request.objective,
    session: {
      id: request.session.id,
      runtimeName: request.session.runtimeName,
      task: request.session.task,
      here: request.session.here,
      there: request.session.there,
      blockers: request.session.blockers,
      policy: request.session.policy
    },
    tools: request.tools
  };
}

function parsePlannerPlanResponse(responseText: string): PlannerPlan {
  const responseJson = parseJson(responseText, "planner model response");
  const content = extractMessageContent(responseJson);
  const planJson = parseJson(stripJsonFence(content), "planner model message content");

  return PlannerPlanSchema.parse(planJson);
}

function extractMessageContent(responseJson: unknown): string {
  const response = responseJson as ChatCompletionResponse;
  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Planner model response did not include choices[0].message.content.");
  }

  return content;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);

  return fenceMatch?.[1] ?? trimmed;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Invalid JSON in ${label}: ${message}`);
  }
}
