import { defineProviderRoute } from "./registry.js";
import type { ProviderRouteDescriptor } from "./schemas.js";
import { BEDROCK_SHEET, K, M, MODEL_SHEET, type SheetModel } from "./modelSheet.js";

/**
 * Direct-first provider catalog, generated from the operator model sheet
 * (`src/providers/modelSheet.ts` ← handoffs/models.xlsx, 2026-07-03) × per-provider
 * lane configs below. Context/max-out come from the sheet (authoritative);
 * thinking/vision flags are provisional (operator: "verification needed"); tool
 * support is assumed per API family and only trusted where live-verified.
 *
 * Credential discipline: env NAMES / cache-file PRESENCE only — values are never
 * read. Operator plan/OAuth lanes never route through LiteLLM.
 */

const SHEET_NOTE = "sheet 2026-07-03: context authoritative; thinking/vision provisional; tools per-family unless live-verified";

interface ProviderLane {
  readonly routeType: "direct-api" | "operator-provider-plan-auth" | "native-cli";
  readonly apiFamily: string;
  readonly baseUrl?: string;
  readonly credentialSource: Record<string, unknown>;
  /** Family-level tool support assumption (sheet's tools column was blank). */
  readonly supportsTools: boolean;
  readonly status: string;
  readonly rankBase: number;
  readonly allowedRouterFallback: boolean;
  readonly caveats?: readonly string[];
  readonly notes?: readonly string[];
  readonly compat?: Record<string, unknown>;
  /** Per-lane wire overrides (auth header style + resolved metadata headers). */
  readonly wire?: Record<string, unknown>;
  /** Prefix applied to the sheet model name to form the API model id. */
  readonly apiModelPrefix?: string;
  /** Exact-name overrides (e.g. Azure deployment names differ from sheet ids). */
  readonly modelAliases?: Readonly<Record<string, string>>;
}

const LANES: Readonly<Record<string, ProviderLane>> = {
  "aws-bedrock": {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    credentialSource: { type: "env-var", envVarName: "BEDROCK_API_KEY", envVarNames: ["AWS_BEARER_TOKEN_BEDROCK"] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 70,
    allowedRouterFallback: true,
    caveats: [
      "Mantle bare /v1 chat surface (x-api-key): serves the glm/qwen/mistral/nvidia/minimax/kimi/deepseek/gpt-oss/gemma-3/palmyra set. gemma-4/grok/gpt-5.x live on the sibling /openai/v1 lane.",
      "Tier-0 account — some models feature/entitlement-gated (e.g. gemma-4: 401 'Berm not enabled'); probe-verified, self-heals as access grows."
    ],
    notes: ["AWS Bedrock via the OpenAI-compatible endpoint (bearer API key; no SigV4 needed)."]
  },
  "aws-bedrock-oai": {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
    credentialSource: { type: "env-var", envVarName: "BEDROCK_API_KEY", envVarNames: ["AWS_BEARER_TOKEN_BEDROCK"] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 72,
    allowedRouterFallback: true,
    caveats: [
      "Mantle /openai/v1 surface (bearer + OpenAI-Project: default; operator-discovered): serves gemma-4, grok-4.3, gpt-5.x. Disjoint from the bare /v1 surface. gpt-5.x 401 flagship-gated at tier 0."
    ],
    notes: ["Second mantle OpenAI-compat surface — model sets are disjoint between /v1 and /openai/v1."]
  },
  "aws-bedrock-anthropic": {
    routeType: "direct-api",
    apiFamily: "anthropic-messages",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    credentialSource: { type: "env-var", envVarName: "BEDROCK_API_KEY", envVarNames: ["AWS_BEARER_TOKEN_BEDROCK"] },
    supportsTools: true,
    status: "needs-login",
    rankBase: 75,
    allowedRouterFallback: true,
    caveats: [
      "Bedrock mantle anthropic-messages surface (POST /anthropic/v1/messages, x-api-key). GET /v1/models lists these as catalog-available, but invocation returns 403 'not available for this account' — account entitlement/tier gating, NOT a config error (verified 2026-07-03). Self-heals when the account is entitled; fable-5 additionally blocked by data-retention mode 'default'."
    ],
    notes: ["Claude on Bedrock via the mantle anthropic-messages surface."]
  },
  anthropic: {
    routeType: "direct-api",
    apiFamily: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    credentialSource: { type: "env-var", envVarName: "ANTHROPIC_API_KEY", envVarNames: [], oauthPolicy: "forbidden" },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 10,
    allowedRouterFallback: true,
    notes: [
      "Direct Anthropic lane.",
      "oauthPolicy=forbidden (encoded 2026-07-04): Anthropic subscription/ecosystem OAuth must never be used for API calls (ToS; crush PR #1783 precedent). ANTHROPIC_API_KEY via env or the op credential store is the only sanctioned path."
    ]
  },
  "azure-foundry": {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "os.environ/AZURE_AI_FOUNDRY_PROJECT_ENDPOINT",
    credentialSource: { type: "env-var", envVarName: "AZURE_FOUNDRY_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 50,
    allowedRouterFallback: true,
    // Foundry deployments are case-sensitive names on the unified /openai/v1 surface
    // (management plane confirmed: DeepSeek-V4-*, Kimi-K2.6 vs the sheet's lowercase).
    modelAliases: {
      "deepseek-v4-flash": "DeepSeek-V4-Flash",
      "deepseek-v4-pro": "DeepSeek-V4-Pro",
      "kimi-k2.6": "Kimi-K2.6"
    },
    notes: ["Azure Foundry deployments via the unified OpenAI v1 surface; api-key header auth."]
  },
  "azure-openai-responses": {
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "os.environ/AZURE_OPENAI_API_ENDPOINT",
    credentialSource: { type: "env-var", envVarName: "AZURE_OPENAI_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 15,
    allowedRouterFallback: true,
    caveats: [
      "TIER-GATED (2026-07-03): the account is Azure tier 0 — GPT-5.5/5.5-Pro/codex deployments are unavailable until higher quota tiers. Routes stay cataloged; rerun capability-probe as tiers climb.",
      "Resource endpoint from AZURE_OPENAI_API_ENDPOINT; /openai/v1 path composed automatically; api-key header auth."
    ],
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true, requiresMaxCompletionTokens: true }
  },
  bigmodel: {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    credentialSource: { type: "env-var", envVarName: "BIGMODEL_API_KEY", envVarNames: ["ZHIPU_API_KEY"] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 48,
    allowedRouterFallback: true,
    notes: ["BigModel/Zhipu mainland lane."]
  },
  deepseek: {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com",
    credentialSource: { type: "env-var", envVarName: "DEEPSEEK_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 55,
    allowedRouterFallback: true
  },
  gemini: {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentialSource: { type: "env-var", envVarName: "GEMINI_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 20,
    allowedRouterFallback: true,
    notes: ["Google AI Studio via the OpenAI-compatibility endpoint — chat+agent capable without a bespoke family adapter."]
  },
  grok: {
    routeType: "operator-provider-plan-auth",
    apiFamily: "openai-responses",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    credentialSource: { type: "guru-oauth", envVarNames: [] },
    supportsTools: true,
    status: "needs-login",
    rankBase: 34,
    allowedRouterFallback: false,
    wire: {
      headers: [{ header: "x-grok-client-version", filePath: "~/.grok/version.json", jsonPath: "version", fallback: "0.1.202" }]
    },
    caveats: [
      "SuperGrok PLAN lane — guru-native OAuth (auth.x.ai loopback via `/login grok`) OR the ~/.grok/auth.json SHORTCUT if the grok CLI is already signed in; token lives in guru's encrypted vault (never a guru file, never a CLI dependency). Chat @ cli-chat-proxy.grok.com/v1 (openai-responses) + the x-grok-client-version header.",
      "Grok 4.5 (2026-07): added to SuperGrok — probe-verify availability at the plan tier. Standard SuperGrok may 403 at inference for higher models; the 'xai' api.x.ai key lane is the sanctioned per-token fallback.",
      "compat.supportsReasoningEffort false per the reference working config."
    ],
    compat: { supportsReasoningEffort: false }
  },
  minimax: {
    routeType: "direct-api",
    apiFamily: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    credentialSource: { type: "env-var", envVarName: "MINIMAX_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 30,
    allowedRouterFallback: true,
    wire: { authHeaderStyle: "bearer" },
    notes: ["MiniMax coding lane — Anthropic-compat @ api.minimax.io/anthropic (vendor-recommended FULL setup: M3 1M ctx + M2.7, tools/streaming/thinking). ONE key MINIMAX_API_KEY sent as Bearer (not x-api-key). The api.minimax.io/v1 openai face adds no models/features for coding."]
  },
  openai: {
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    credentialSource: { type: "env-var", envVarName: "OPENAI_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 26,
    allowedRouterFallback: true,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true, requiresMaxCompletionTokens: true }
  },
  // "openai-codex" CLI-DELEGATE lane removed 2026-07 (the codex.cmd/sandbox path is
  // retired). The ChatGPT plan runs NATIVELY via openai-codex — see
  // CODEX_DIRECT_ROUTES below. OpenAI now has exactly two lanes: this plan lane and the
  // "openai" API-platform lane.
  "perplexity-agent": {
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "https://api.perplexity.ai/v1",
    credentialSource: { type: "env-var", envVarName: "PERPLEXITY_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 65,
    allowedRouterFallback: true,
    // Perplexity Agent API: /v1/responses is a documented OpenAI-compat alias of
    // /v1/agent; live GET /v1/models confirms UNPREFIXED ids (anthropic/claude-…).
    notes: ["Perplexity Agent API — third-party models via Perplexity billing."]
  },
  "perplexity-sonar": {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://api.perplexity.ai",
    credentialSource: { type: "env-var", envVarName: "PERPLEXITY_API_KEY", envVarNames: [] },
    supportsTools: false,
    status: "works-with-caveat",
    rankBase: 60,
    allowedRouterFallback: true,
    caveats: ["Search-grounded lane; spend controls and tool adapters remain follow-ups."],
    notes: ["Web-search grounded responses."]
  },
  sakana: {
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "https://api.sakana.ai/v1",
    credentialSource: { type: "env-var", envVarName: "SAKANA_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 3,
    allowedRouterFallback: true,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true, requiresMaxCompletionTokens: true }
  },
  xai: {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://api.x.ai/v1",
    credentialSource: { type: "env-var", envVarName: "XAI_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 35,
    allowedRouterFallback: true
  },
  "zai-api": {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    credentialSource: { type: "env-var", envVarName: "ZAI_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 45,
    allowedRouterFallback: true,
    notes: ["Z.ai INTERNATIONAL API platform (pay-per-token), OpenAI-compat @ api.z.ai/api/paas/v4, Bearer ZAI_API_KEY. Retargeted 2026-07 off open.bigmodel.cn (that Zhipu-mainland lane is the separate 'bigmodel' provider). Distinct from the coding plan ('zai-coding')."]
  },
  "zai-coding": {
    routeType: "operator-provider-plan-auth",
    apiFamily: "anthropic-messages",
    baseUrl: "https://api.z.ai/api/anthropic",
    credentialSource: {
      type: "env-var",
      envVarName: "ZAI_CODING_CN_API_KEY",
      envVarNames: ["Z_AI_API_KEY", "ZCODE_API_KEY"]
    },
    supportsTools: true,
    status: "active",
    rankBase: 7,
    allowedRouterFallback: false,
    wire: { authHeaderStyle: "bearer" },
    caveats: [
      "Z.ai GLM Coding Plan (GLM Coding Max subscription) — anthropic-messages @ api.z.ai/api/anthropic, plain Bearer plan key (NOT x-api-key). FULL coding set: glm-5.2 / glm-5.2[1m] (1M) / glm-5-turbo / glm-4.7 (chat+tools+thinking). GLM vision is API-token-only — use 'bigmodel'. One coding key: ZAI_CODING_CN_API_KEY == Z_AI_API_KEY == ZCODE_API_KEY (2026-07: dropped the stale ~/.zcode oauth-cache fields — it's a plain plan key).",
      "Operator-owned coding-plan auth; tool-locked, never route the client-locked token through LiteLLM."
    ]
  }
};

/**
 * Flagship-first rank overrides (sheet row order is not preference order):
 * auto-connect and the planner should prefer these over their provider siblings.
 */
const RANK_OVERRIDES: Readonly<Record<string, number>> = {
  "sakana/fugu-ultra": 3,
  "sakana/fugu": 4,
  "openai/gpt-5.6-sol": 5,
  "anthropic/claude-fable-5": 10,
  "anthropic/claude-sonnet-5": 11,
  "anthropic/claude-opus-4-8": 12,
  "anthropic/claude-haiku-4-5": 13,
  "xai/grok-4.5": 16,
  "gemini/gemini-3.5-flash": 20,
  "gemini/gemini-3.1-flash-lite": 21,
  "gemini/gemini-3.1-pro-preview": 22,
  "gemini/gemini-3.1-pro-preview-customtools": 23,
  "zai-api/glm-5.2": 45,
  "zai-api/glm-5-turbo": 46,
  "zai-api/glm-4.7": 47,
  "zai-api/glm-5v-turbo": 48
};

function routeFromSheet(row: SheetModel, indexInProvider: number): ProviderRouteDescriptor {
  const lane = LANES[row.provider];
  if (!lane) {
    throw new Error(`No lane config for sheet provider '${row.provider}'.`);
  }

  return defineProviderRoute({
    providerId: row.provider,
    modelId: lane.modelAliases?.[row.model] ?? `${lane.apiModelPrefix ?? ""}${row.model}`,
    routeId: `${row.provider}/${row.model}`,
    routeType: lane.routeType,
    apiFamily: lane.apiFamily,
    ...(lane.baseUrl !== undefined ? { baseUrl: lane.baseUrl } : {}),
    credentialSource: lane.credentialSource,
    capabilities: {
      supportsStreaming: lane.routeType !== "native-cli",
      supportsTools: lane.supportsTools,
      supportsReasoning: row.thinking,
      supportsVision: row.images,
      notes: [SHEET_NOTE, ...(lane.notes ?? [])]
    },
    context: { contextWindowTokens: row.contextTokens, maxOutputTokens: row.maxOutputTokens },
    ...(lane.compat !== undefined ? { compat: lane.compat } : {}),
    status: lane.status,
    ...(lane.caveats !== undefined ? { caveats: [...lane.caveats] } : {}),
    ...(lane.wire !== undefined ? { wire: lane.wire } : {}),
    directFirstRank: RANK_OVERRIDES[`${row.provider}/${row.model}`] ?? lane.rankBase + indexInProvider,
    allowedRouterFallback: lane.allowedRouterFallback
  } as Parameters<typeof defineProviderRoute>[0]);
}

/**
 * Codex-direct routes (Phase B, 2026-07-04) — a SECOND route beside the delegate
 * (openai-codex/*), speaking the Responses API directly against the ChatGPT
 * backend with the plan OAuth token from ~/.codex/auth.json. Manual (not
 * sheet-driven) so the delegate lane stays untouched and reachable on 401.
 * Status stays needs-login until a probe-verified live turn flips it.
 */
const CODEX_DIRECT_WIRE: Record<string, unknown> = {
  headers: [
    { header: "ChatGPT-Account-Id", oauthAccount: true },
    { header: "OpenAI-Beta", literal: "responses=experimental" },
    { header: "originator", literal: "codex_cli_rs" }
  ],
  // The codex Responses backend rejects requests unless store is false and the
  // request streams; it also rejects max_output_tokens.
  bodyExtras: { store: false },
  requireStreaming: true,
  omitMaxTokens: true
};

function codexDirectRoute(model: string, contextTokens: number, maxOutputTokens: number, rank: number): ProviderRouteDescriptor {
  return defineProviderRoute({
    providerId: "openai-codex",
    modelId: model,
    routeId: `openai-codex/${model}`,
    routeType: "operator-provider-plan-auth",
    apiFamily: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    credentialSource: {
      type: "guru-oauth",
      envVarNames: []
    },
    capabilities: { supportsStreaming: true, supportsTools: true, supportsReasoning: true, notes: ["Codex plan direct Responses lane; token from guru's OWN sign-in (/login codex) in the encrypted vault — no ~/.codex cache."] },
    context: { contextWindowTokens: contextTokens, maxOutputTokens },
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true, requiresMaxCompletionTokens: true },
    status: "active",
    caveats: [
      "Direct Responses lane to chatgpt.com/backend-api/codex; Bearer access_token + ChatGPT-Account-Id from ~/.codex/auth.json, OpenAI-Beta + originator headers, store=false + stream=true + no max_output_tokens (codex backend requirements).",
      "GPT-5.6 generation (2026-07): Sol (flagship), Luna (balanced), Terra (fast). Model sheet is authoritative; probe-verify each on the codex plan."
    ],
    wire: CODEX_DIRECT_WIRE,
    directFirstRank: rank,
    allowedRouterFallback: false
  } as Parameters<typeof defineProviderRoute>[0]);
}

const CODEX_DIRECT_ROUTES: readonly ProviderRouteDescriptor[] = [
  // ChatGPT-plan native lanes ranked #1/#2 (2026-07): the top auto-connect picks
  // once you /login to your ChatGPT plan.
  codexDirectRoute("gpt-5.6-sol", 2048 * 1024, 128 * 1024, 1),
  codexDirectRoute("gpt-5.6-luna", 1024 * 1024, 128 * 1024, 2)
];

/** Local bonus lane — not on the operator sheet, kept because it needs no credentials. */
const OLLAMA_LOCAL = defineProviderRoute({
  providerId: "ollama-local",
  modelId: "local-openai-compatible",
  routeId: "ollama-local/local-openai-compatible",
  routeType: "direct-api",
  apiFamily: "ollama-openai-compatible",
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialSource: { type: "none", envVarNames: [] },
  capabilities: { supportsStreaming: true, notes: ["Local/LAN OpenAI-compatible Ollama route; no real API key required."] },
  status: "ready-unverified",
  directFirstRank: 40,
  allowedRouterFallback: false
});

function buildCatalog(): readonly ProviderRouteDescriptor[] {
  const counters = new Map<string, number>();
  const routes = [...MODEL_SHEET, ...BEDROCK_SHEET].map((row) => {
    const index = counters.get(row.provider) ?? 0;
    counters.set(row.provider, index + 1);
    return routeFromSheet(row, index);
  });

  return [...routes, ...CODEX_DIRECT_ROUTES, OLLAMA_LOCAL];
}

export const DIRECT_PROVIDER_CATALOG: readonly ProviderRouteDescriptor[] = buildCatalog();

export function createDirectProviderCatalog(): readonly ProviderRouteDescriptor[] {
  return [...DIRECT_PROVIDER_CATALOG];
}
