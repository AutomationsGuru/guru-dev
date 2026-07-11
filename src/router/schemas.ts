import { z } from "zod";

export const LiteLlmProviderGroupSchema = z.enum([
  "openai-platform",
  "anthropic-api",
  "gemini-ai-studio",
  "azure-foundry",
  "bigmodel-zhipu",
  "minimax",
  "sakana",
  "xai-api",
  "perplexity-sonar",
  "legacy-compatibility",
  "vertex-claude"
]);

export type LiteLlmProviderGroup = z.infer<typeof LiteLlmProviderGroupSchema>;

export const LITELLM_BASELINE_ALIASES = [
  "router-openai-gpt-5-5",
  "router-openai-gpt-5-5-pro",
  "router-openai-api",
  "router-claude-opus-4-8",
  "router-claude-sonnet-4-6",
  "router-claude-fable-5",
  "router-claude-haiku-4-5",
  "router-claude-api",
  "router-gemini-3-1-pro",
  "router-gemini-3-5-flash",
  "router-gemini-3-1-flash-lite",
  "router-gemini-pro",
  "router-gemini-flash",
  "router-foundry-pro",
  "router-foundry-fast",
  "router-foundry-luna",
  "router-kimi",
  "router-deepseek",
  "router-deepseek-flash",
  "router-grok",
  "router-xai-grok-4-3",
  "router-glm-5-2",
  "router-glm-5-turbo",
  "router-glm-5v-turbo",
  "router-minimax-m3",
  "router-minimax-m27-highspeed",
  "router-minimax-m27",
  "router-fugu",
  "router-fugu-ultra",
  "router-perplexity-sonar",
  "router-perplexity-sonar-pro",
  "router-perplexity-sonar-reasoning-pro",
  "router-perplexity-sonar-deep-research",
  "router-sonnet",
  "router-haiku",
  "router-opus",
  "router-vertex-claude-opus-4-8",
  "router-vertex-claude-sonnet-4-6",
  "router-vertex-claude-haiku-4-5"
] as const;

export const LITELLM_PROVIDER_GROUPS = [
  "openai-platform",
  "anthropic-api",
  "gemini-ai-studio",
  "azure-foundry",
  "bigmodel-zhipu",
  "minimax",
  "sakana",
  "xai-api",
  "perplexity-sonar",
  "legacy-compatibility",
  "vertex-claude"
] as const;

export const LiteLlmAliasSchema = z
  .object({
    alias: z.string().min(1),
    providerGroup: LiteLlmProviderGroupSchema,
    provider: z.string().min(1).optional(),
    model: z.string().min(1),
    apiBase: z.string().min(1).optional(),
    apiBaseEnvVarNames: z.array(z.string().min(1)).default([]),
    credentialEnvVarNames: z.array(z.string().min(1)).default([]),
    litellmParams: z.record(z.string(), z.string()).default({}),
    metadata: z
      .object({
        router_aliases: z.array(z.string().min(1)).default([])
      })
      .catchall(z.unknown())
      .default({ router_aliases: [] })
  })
  .strict();

export type LiteLlmAlias = z.infer<typeof LiteLlmAliasSchema>;

export const LiteLlmBaselineValidationSchema = z
  .object({
    expectedAliasCount: z.number().int().nonnegative(),
    expectedProviderGroupCount: z.number().int().nonnegative(),
    aliasCount: z.number().int().nonnegative(),
    providerGroupCount: z.number().int().nonnegative(),
    missingAliases: z.array(z.string()),
    extraAliases: z.array(z.string()),
    missingProviderGroups: z.array(LiteLlmProviderGroupSchema),
    extraProviderGroups: z.array(z.string()),
    verdict: z.enum(["GREEN", "YELLOW", "RED"])
  })
  .strict();

export type LiteLlmBaselineValidation = z.infer<typeof LiteLlmBaselineValidationSchema>;

export const LiteLlmConfigManifestSchema = z
  .object({
    aliases: z.array(LiteLlmAliasSchema),
    providerGroups: z.array(LiteLlmProviderGroupSchema),
    metadata: z
      .object({
        router_aliases: z.array(z.string().min(1)).default([])
      })
      .catchall(z.unknown())
      .default({ router_aliases: [] }),
    baseline: LiteLlmBaselineValidationSchema
  })
  .strict();

export type LiteLlmConfigManifest = z.infer<typeof LiteLlmConfigManifestSchema>;
