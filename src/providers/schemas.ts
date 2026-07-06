import { z } from "zod";

export const RouteTypeSchema = z.enum([
  "direct-api",
  "operator-provider-plan-auth",
  "native-cli",
  "router-bridge",
  "delegated",
  "deferred",
  "excluded"
]);

export type RouteType = z.infer<typeof RouteTypeSchema>;

export const RouteStatusSchema = z.enum([
  "active",
  "guarded",
  "ready-unverified",
  "missing-credential",
  "needs-login",
  "router-offline",
  "pending-quota",
  "works-with-caveat",
  "untested",
  "failing",
  "delegated",
  "deferred",
  "excluded-by-policy"
]);

export type RouteStatus = z.infer<typeof RouteStatusSchema>;

export const ModalitySchema = z.enum(["text", "image", "audio", "video", "file", "json"]);
export type Modality = z.infer<typeof ModalitySchema>;

export const ApiFamilySchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
  "google-cloud-gemini",
  "ollama-openai-compatible",
  "litellm-openai-compatible",
  "native-cli",
  "custom"
]);

export type ApiFamily = z.infer<typeof ApiFamilySchema>;

export const CredentialSourceTypeSchema = z.enum([
  "env-var",
  "windows-user-env",
  "auth-file",
  "oauth-cache",
  "guru-oauth",
  "native-cli-token",
  "adc",
  "command-helper",
  "router-key",
  "none"
]);

export type CredentialSourceType = z.infer<typeof CredentialSourceTypeSchema>;

/**
 * Per-provider OAuth/ecosystem-token policy (mini-catwalk column, 2026-07-04):
 * - "ecosystem-ok": guru may READ the provider ecosystem's own token cache
 *   (e.g. ~/.codex/auth.json) as a last-resort credential layer.
 * - "forbidden": ecosystem/subscription tokens must never be used for API calls.
 *   Anthropic is hard-forbidden (ToS; crush PR #1783 precedent) — API key only.
 */
export const OauthPolicySchema = z.enum(["ecosystem-ok", "forbidden"]);

export type OauthPolicy = z.infer<typeof OauthPolicySchema>;

export const CredentialSourceSchema = z
  .object({
    type: CredentialSourceTypeSchema,
    envVarName: z.string().min(1).optional(),
    envVarNames: z.array(z.string().min(1)).default([]),
    filePath: z.string().min(1).optional(),
    commandName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    /**
     * Credential template resolved at connect time (crush shellVariableResolver
     * semantics): "$VAR", "${VAR}", "$(command)", or an op credential-store reference
     * "op://Vault/Item/field". The template names WHERE a value comes from —
     * it never carries a value itself.
     */
    template: z.string().min(1).optional(),
    /**
     * Dot-path to the token inside the ecosystem cache file named by filePath
     * (e.g. "tokens.access_token"). A "*" segment matches the first object
     * value (for caches keyed by dynamic ids, e.g. ~/.grok/auth.json).
     */
    cacheTokenPath: z.string().min(1).optional(),
    oauthPolicy: OauthPolicySchema.optional(),
    secretValuePresent: z.never().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.type === "env-var" || value.type === "windows-user-env" || value.type === "router-key") && !value.envVarName && value.envVarNames.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.type} credential sources must name at least one env var.`, path: ["envVarName"] });
    }

    if ((value.type === "auth-file" || value.type === "oauth-cache") && !value.filePath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.type} credential sources must include a filePath shape.`, path: ["filePath"] });
    }

    if (value.type === "command-helper" && !value.commandName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "command-helper credential sources must include commandName.", path: ["commandName"] });
    }
  });

export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

/**
 * A single per-lane request header resolved at call time (Phase B, 2026-07-04).
 * Value comes from the first present source: literal → env var → ecosystem file
 * (dot-path, "*" = first object value) → fallback. Header VALUES here are
 * non-secret metadata (client versions, account ids) — the auth token itself
 * still flows only through the credential resolver + auth header.
 */
export const WireHeaderSchema = z
  .object({
    header: z.string().min(1),
    literal: z.string().min(1).optional(),
    envVar: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    jsonPath: z.string().min(1).optional(),
    /** Resolve this header from guru's own vaulted OAuth token account id (never a cache). */
    oauthAccount: z.boolean().optional(),
    fallback: z.string().min(1).optional()
  })
  .strict();

export type WireHeader = z.infer<typeof WireHeaderSchema>;

/**
 * Per-lane wire overrides. `authHeaderStyle` overrides the family default (e.g.
 * zai-coding-cn speaks anthropic-messages but authenticates with a Bearer key,
 * not x-api-key); `headers` adds resolved metadata headers (grok client version,
 * codex ChatGPT-Account-Id + OpenAI-Beta + originator).
 */
export const RouteWireSchema = z
  .object({
    authHeaderStyle: z.enum(["bearer", "api-key", "x-api-key"]).optional(),
    headers: z.array(WireHeaderSchema).default([]),
    /**
     * Extra request-body fields a lane requires (non-secret). E.g. the codex
     * Responses backend rejects requests unless `store: false`.
     */
    bodyExtras: z.record(z.string(), z.unknown()).optional(),
    /** Force SSE streaming even without an onToken sink (codex rejects non-stream). */
    requireStreaming: z.boolean().optional(),
    /** Omit max_output_tokens from the Responses body (codex rejects it). */
    omitMaxTokens: z.boolean().optional()
  })
  .strict();

export type RouteWire = z.infer<typeof RouteWireSchema>;

export const ProviderCapabilitiesSchema = z
  .object({
    inputModalities: z.array(ModalitySchema).default(["text"]),
    outputModalities: z.array(ModalitySchema).default(["text"]),
    supportsTools: z.boolean().default(false),
    supportsStreaming: z.boolean().default(true),
    supportsReasoning: z.boolean().default(false),
    supportsWebSearch: z.boolean().default(false),
    supportsVision: z.boolean().default(false),
    supportsJsonMode: z.boolean().default(false),
    supportsImages: z.boolean().default(false),
    notes: z.array(z.string().min(1)).default([])
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const RouteContextSchema = z
  .object({
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reserveOutputTokens: z.number().int().nonnegative().optional()
  })
  .strict();

export type RouteContext = z.infer<typeof RouteContextSchema>;

export const RouteCostSchema = z
  .object({
    currency: z.string().min(1).default("USD"),
    inputPerMillionTokens: z.number().nonnegative().optional(),
    outputPerMillionTokens: z.number().nonnegative().optional(),
    requestCost: z.number().nonnegative().optional(),
    notes: z.array(z.string().min(1)).default([]),
    source: z.string().min(1).optional()
  })
  .strict();

export type RouteCost = z.infer<typeof RouteCostSchema>;

export const RouteCompatSchema = z
  .object({
    supportsDeveloperRole: z.boolean().optional(),
    supportsSystemRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsTemperature: z.boolean().optional(),
    supportsTopP: z.boolean().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    requiresMaxCompletionTokens: z.boolean().optional()
  })
  .strict();

export type RouteCompat = z.infer<typeof RouteCompatSchema>;

export const ProviderRouteDescriptorSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    routeId: z.string().min(1),
    displayName: z.string().min(1).optional(),
    routeType: RouteTypeSchema,
    apiFamily: ApiFamilySchema.optional(),
    baseUrl: z.string().min(1).optional(),
    capabilities: ProviderCapabilitiesSchema.default(() => ProviderCapabilitiesSchema.parse({})),
    context: RouteContextSchema.default({}),
    cost: RouteCostSchema.default(() => RouteCostSchema.parse({})),
    credentialSource: CredentialSourceSchema.default({ type: "none", envVarNames: [] }),
    status: RouteStatusSchema,
    caveats: z.array(z.string().min(1)).default([]),
    compat: RouteCompatSchema.default({}),
    wire: RouteWireSchema.optional(),
    directFirstRank: z.number().int().nonnegative(),
    allowedRouterFallback: z.boolean(),
    exclusionReason: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.routeType === "excluded" && !value.exclusionReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Excluded routes must include exclusionReason.", path: ["exclusionReason"] });
    }

    if (value.status === "excluded-by-policy" && !value.exclusionReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "excluded-by-policy routes must include exclusionReason.", path: ["exclusionReason"] });
    }

    if (value.routeType === "operator-provider-plan-auth" && value.allowedRouterFallback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Operator provider-plan/native auth routes cannot be routable through LiteLLM by default.",
        path: ["allowedRouterFallback"]
      });
    }
  });

export type ProviderRouteDescriptor = z.infer<typeof ProviderRouteDescriptorSchema>;
export type ProviderRouteDescriptorInput = z.input<typeof ProviderRouteDescriptorSchema>;

export const ProviderRouteRegistrySnapshotSchema = z
  .object({
    routes: z.array(ProviderRouteDescriptorSchema),
    generatedAt: z.string().datetime().optional()
  })
  .strict();

export type ProviderRouteRegistrySnapshot = z.infer<typeof ProviderRouteRegistrySnapshotSchema>;
