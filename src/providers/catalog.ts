import { defineProviderRoute } from "./registry.js";
import type { ProviderRouteDescriptor } from "./schemas.js";
import { BEDROCK_SHEET, MODEL_SHEET, type SheetModel } from "./modelSheet.js";

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
    credentialSource: { type: "env-var", envVarName: "BEDROCK_API_KEY", envVarNames: [] },
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
    credentialSource: { type: "env-var", envVarName: "BEDROCK_API_KEY", envVarNames: [] },
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
    credentialSource: { type: "env-var", envVarName: "BEDROCK_API_KEY", envVarNames: [] },
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
    baseUrl: "os.environ/AZURE_OPENAI_API_ENDPOINT",
    credentialSource: { type: "env-var", envVarName: "AZURE_FOUNDRY_API_KEY", envVarNames: ["AZURE_OPENAI_API_ENDPOINT"] },
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
    credentialSource: { type: "env-var", envVarName: "AZURE_OPENAI_API_KEY", envVarNames: ["AZURE_OPENAI_API_ENDPOINT"] },
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
  "grok-cli": {
    routeType: "native-cli",
    apiFamily: "openai-responses",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    credentialSource: {
      type: "oauth-cache",
      envVarName: "XAI_API_KEY",
      envVarNames: [],
      filePath: "~/.grok/auth.json",
      cacheTokenPath: "*.access_token",
      oauthPolicy: "ecosystem-ok"
    },
    supportsTools: true,
    status: "delegated",
    rankBase: 80,
    allowedRouterFallback: false,
    wire: {
      headers: [{ header: "x-grok-client-version", filePath: "~/.grok/version.json", jsonPath: "version", fallback: "0.1.202" }]
    },
    caveats: [
      "Family+endpoint corrected 2026-07-04 from a reference working config (was native-cli-only): direct openai-responses @ cli-chat-proxy.grok.com/v1, Bearer from ~/.grok/auth.json (OIDC self-refresh) + x-grok-client-version header. Wiring complete; NOT flipped.",
      "PROBE 2026-07-04 (two rounds): env XAI_API_KEY → 401 'x_xai_token_auth=none, Unauthenticated' (the api.x.ai key is NOT accepted by the cli-chat proxy). The ~/.grok/auth.json access_token is RECOGNIZED (401 shifts to 'PermissionDenied') but still rejected — the cached token is expired/unentitled. Resolution: refresh via `grok auth` (OIDC self-refresh through auth.x.ai) or an account entitlement, NOT a wiring change. Stays delegated until a fresh token passes.",
      "compat.supportsReasoningEffort false per the reference working config."
    ],
    compat: { supportsReasoningEffort: false }
  },
  minimax: {
    routeType: "direct-api",
    apiFamily: "openai-responses",
    baseUrl: "https://api.minimax.io/v1",
    credentialSource: { type: "env-var", envVarName: "MINIMAX_API_KEY", envVarNames: [] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 30,
    allowedRouterFallback: true
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
  "openai-codex": {
    routeType: "operator-provider-plan-auth",
    apiFamily: "openai-responses",
    credentialSource: { type: "native-cli-token", commandName: "codex.cmd", envVarNames: [] },
    supportsTools: true,
    status: "needs-login",
    rankBase: 1,
    allowedRouterFallback: false,
    caveats: ["Codex/ChatGPT plan auth via local CLI; never routed through LiteLLM."],
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true, requiresMaxCompletionTokens: true }
  },
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
  zai: {
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    credentialSource: { type: "env-var", envVarName: "BIGMODEL_API_KEY", envVarNames: ["ZHIPU_API_KEY"] },
    supportsTools: true,
    status: "ready-unverified",
    rankBase: 45,
    allowedRouterFallback: true,
    notes: ["Z.AI GLM via BigModel API-key lane (agentic loop live-verified on glm-5-turbo)."]
  },
  "zai-coding-cn": {
    routeType: "operator-provider-plan-auth",
    apiFamily: "anthropic-messages",
    baseUrl: "https://api.z.ai/api/anthropic",
    credentialSource: {
      type: "env-var",
      envVarName: "ZAI_CODING_CN_API_KEY",
      envVarNames: ["ZAI_API_KEY", "ZCODE_API_KEY"],
      filePath: "~/.zcode/v2/config.json",
      cacheTokenPath: "provider.builtin:zai-coding-plan.options.apiKey",
      oauthPolicy: "ecosystem-ok"
    },
    supportsTools: true,
    status: "active",
    rankBase: 7,
    allowedRouterFallback: false,
    wire: { authHeaderStyle: "bearer" },
    caveats: [
      "VERIFIED 2026-07-04 (Phase B): anthropic-messages @ api.z.ai/api/anthropic, plain Bearer plan key. Live-probed PASS on glm-5.2/glm-5-turbo/glm-4.7 (chat+tools+thinking); glm-5v-turbo fails on this plan. Status flipped to active on probe evidence.",
      "Operator-owned coding-plan auth; never route the client-locked token through LiteLLM."
    ]
  }
};

/**
 * Flagship-first rank overrides (sheet row order is not preference order):
 * auto-connect and the planner should prefer these over their provider siblings.
 */
const RANK_OVERRIDES: Readonly<Record<string, number>> = {
  "openai-codex/gpt-5.5": 1,
  "openai-codex/gpt-5.3-codex-spark": 2,
  "sakana/fugu-ultra": 3,
  "sakana/fugu": 4,
  "anthropic/claude-fable-5": 10,
  "anthropic/claude-sonnet-5": 11,
  "anthropic/claude-opus-4-8": 12,
  "anthropic/claude-haiku-4-5": 13,
  "gemini/gemini-3.5-flash": 20,
  "gemini/gemini-3.1-flash-lite": 21,
  "gemini/gemini-3.1-pro-preview": 22,
  "gemini/gemini-3.1-pro-preview-customtools": 23,
  "zai/glm-5.2": 45,
  "zai/glm-5-turbo": 46,
  "zai/glm-4.7": 47,
  "zai/glm-5v-turbo": 48
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
    providerId: "openai-codex-direct",
    modelId: model,
    routeId: `openai-codex-direct/${model}`,
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
      "Direct Responses lane to chatgpt.com/backend-api/codex; Bearer access_token + ChatGPT-Account-Id from ~/.codex/auth.json, OpenAI-Beta + originator headers, store=false + stream=true + no max_output_tokens (codex backend requirements). Delegate lane (openai-codex/*) stays reachable.",
      "VERIFIED 2026-07-04 (Finale Wave): chat PASS on gpt-5.5 + gpt-5.3-codex-spark. Codex streams text only via output_text.delta and sends a response.completed with an EMPTY output[] — the stream parser now backfills the accumulated delta text. Flipped to active on probe evidence."
    ],
    wire: CODEX_DIRECT_WIRE,
    directFirstRank: rank,
    allowedRouterFallback: false
  } as Parameters<typeof defineProviderRoute>[0]);
}

const CODEX_DIRECT_ROUTES: readonly ProviderRouteDescriptor[] = [
  codexDirectRoute("gpt-5.5", 272 * 1024, 128 * 1024, 2),
  codexDirectRoute("gpt-5.3-codex-spark", 128 * 1024, 128 * 1024, 3)
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
