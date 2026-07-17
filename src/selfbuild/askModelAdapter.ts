import { directAgentTurn, type AgentTurnOptions } from "../model/agentTurn.js";
import { DEFAULT_RETRY_CONFIG, type RetryConfig } from "../model/retryPolicy.js";
import type { PlannerModelConfig } from "../model/schemas.js";
import { defineProviderRoute } from "../providers/registry.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";
import type { AskModel } from "../review/nativeCriticPanel.js";

/** REVIEW model calls are bounded — a blackholed critic must not hang the cycle. */
const REVIEW_RETRY: RetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  provider: { ...DEFAULT_RETRY_CONFIG.provider, timeoutMs: 120_000 }
};

/** A chat route for the configured model — reuses the planner's provider/base/key for critics. */
export function routeFromPlannerConfig(model: PlannerModelConfig): ProviderRouteDescriptor {
  return defineProviderRoute({
    providerId: "config-planner",
    modelId: model.model,
    routeId: `config-planner/${model.model}`,
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: model.baseUrl,
    credentialSource: { type: "env-var", envVarName: model.apiKeyEnvVar, envVarNames: [] },
    status: "ready-unverified",
    directFirstRank: 1,
    allowedRouterFallback: false
  });
}

/**
 * Build an `AskModel` from a provider route (self-build P7) — the single-turn model call
 * guru's native critics use for REVIEW. Critics are read-only, so the turn is given NO tools
 * and zero tool calls: the model can only return text, there is nothing to deny. This is the
 * adapter that lets `--run` review with a LIVE model instead of degrading REVIEW to YELLOW.
 */
export function makeAskModelFromRoute(route: ProviderRouteDescriptor, options: Partial<AgentTurnOptions> = {}): AskModel {
  return async (prompt) => {
    const result = await directAgentTurn(route, [{ role: "user", content: prompt }], {
      ...options,
      // Bound the critic call so a blackholed provider cannot hang the cycle forever.
      retry: options.retry ?? REVIEW_RETRY,
      // Read-only by construction: no tools, no tool calls, so the no-op executor/approver never run.
      tools: [],
      maxToolCalls: 0,
      executeTool: options.executeTool ?? (async () => {
        throw new Error("native critics have no tools");
      }),
      approveTool: options.approveTool ?? (() => false)
    });
    return {
      text: result.text,
      ...(result.usage
        ? {
            usage: {
              input: result.usage.inputTokens ?? 0,
              output: result.usage.outputTokens ?? 0
            }
          }
        : {})
    };
  };
}
