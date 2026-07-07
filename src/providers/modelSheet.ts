/**
 * Operator model sheet — transcribed from `handoffs/models.xlsx` (Matthew, 2026-07-03).
 *
 * Data quality per the operator: context/max-out are authoritative (~99% correct);
 * `thinking`/`images` are PROVISIONAL (some guessed, verification needed); the sheet's
 * tools column was blank (unknown) — tool support is assumed per API family and only
 * trusted where live-verified. Numbers are tokens (1M = 1_000_000, 65.5K = 65_500).
 */

export interface SheetModel {
  readonly provider: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  /** Provisional flag from the sheet — reasoning/thinking support. */
  readonly thinking: boolean;
  /** Provisional flag from the sheet — image/vision input support. */
  readonly images: boolean;
}

const K = 1000;
const M = 1_000_000;

export const MODEL_SHEET: readonly SheetModel[] = [
  { provider: "anthropic", model: "claude-fable-5", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "anthropic", model: "claude-haiku-4-5", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: true, images: true },
  { provider: "anthropic", model: "claude-opus-4-8", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "anthropic", model: "claude-sonnet-5", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "azure-foundry", model: "kimi-k2.6", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "azure-foundry", model: "deepseek-v4-flash", contextTokens: 1 * M, maxOutputTokens: 384 * K, thinking: false, images: false },
  { provider: "azure-foundry", model: "deepseek-v4-pro", contextTokens: 1 * M, maxOutputTokens: 384 * K, thinking: true, images: false },
  { provider: "azure-foundry", model: "grok-4.3", contextTokens: 1 * M, maxOutputTokens: 512 * K, thinking: true, images: false },
  { provider: "azure-foundry", model: "gpt-chat-latest", contextTokens: 272 * K, maxOutputTokens: 128 * K, thinking: false, images: false },
  { provider: "azure-openai-responses", model: "gpt-5.5", contextTokens: 1_100_000, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "azure-openai-responses", model: "gpt-5.5-pro", contextTokens: 1_100_000, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "azure-openai-responses", model: "gpt-5.3-codex-spark", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: true, images: true },
  { provider: "azure-openai-responses", model: "gpt-5.3-codex", contextTokens: 272 * K, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "bigmodel", model: "glm-5.2", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: false, images: false },
  { provider: "bigmodel", model: "glm-5-turbo", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "bigmodel", model: "glm-5v-turbo", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "deepseek", model: "deepseek-v4-flash", contextTokens: 1 * M, maxOutputTokens: 384 * K, thinking: true, images: false },
  { provider: "deepseek", model: "deepseek-v4-pro", contextTokens: 1 * M, maxOutputTokens: 384 * K, thinking: true, images: false },
  { provider: "gemini", model: "gemini-3.1-flash-lite", contextTokens: 1 * M, maxOutputTokens: 65_500, thinking: true, images: true },
  { provider: "gemini", model: "gemini-3.1-pro-preview", contextTokens: 1 * M, maxOutputTokens: 65_500, thinking: true, images: true },
  { provider: "gemini", model: "gemini-3.1-pro-preview-customtools", contextTokens: 1 * M, maxOutputTokens: 65_500, thinking: true, images: true },
  { provider: "gemini", model: "gemini-3.5-flash", contextTokens: 1 * M, maxOutputTokens: 65_500, thinking: true, images: true },
  { provider: "grok", model: "grok-composer-2.5-fast", contextTokens: 200 * K, maxOutputTokens: 200 * K, thinking: false, images: false },
  { provider: "grok", model: "grok-build", contextTokens: 512 * K, maxOutputTokens: 512 * K, thinking: false, images: false },
  { provider: "minimax", model: "minimax-m3", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "minimax", model: "minimax-m2.7", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "minimax", model: "minimax-m2.7-highspeed", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "openai", model: "gpt-5.5", contextTokens: 1_100_000, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "openai", model: "gpt-5.5-pro", contextTokens: 1_100_000, maxOutputTokens: 128 * K, thinking: true, images: true },
  // openai-codex (ChatGPT-plan) DELEGATE rows removed 2026-07 — the ChatGPT plan now runs
  // NATIVELY through the openai-codex token lane (guru's own /login loopback OAuth).
  // No CLI delegate. See CODEX_DIRECT_ROUTES in catalog.ts.
  { provider: "perplexity-agent", model: "anthropic/claude-haiku-4-5", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "perplexity-agent", model: "anthropic/claude-opus-4-7", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "perplexity-agent", model: "anthropic/claude-sonnet-4-6", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "perplexity-sonar", model: "sonar", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "perplexity-sonar", model: "sonar-deep-research", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "perplexity-sonar", model: "sonar-reasoning-pro", contextTokens: 128 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "perplexity-sonar", model: "sonar-pro", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "sakana", model: "fugu", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "sakana", model: "fugu-ultra", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "xai", model: "grok-4.3", contextTokens: 1 * M, maxOutputTokens: 512 * K, thinking: true, images: true },
  { provider: "zai-api", model: "glm-5.2", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "zai-api", model: "glm-4.7", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "zai-api", model: "glm-5-turbo", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "zai-api", model: "glm-5v-turbo", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: true },
  { provider: "zai-coding", model: "glm-5.2", contextTokens: 1 * M, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "zai-coding", model: "glm-4.7", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "zai-coding", model: "glm-5-turbo", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: false },
  { provider: "zai-coding", model: "glm-5v-turbo", contextTokens: 200 * K, maxOutputTokens: 128 * K, thinking: true, images: true }
] as const;

/**
 * Bedrock catalog — the COMPLETE surface from GET https://bedrock-mantle.us-east-1.api.aws/v1/models
 * (51 models, operator-provided endpoint + key, 2026-07-03). Non-anthropic ids use the
 * mantle OpenAI-compat lane (/v1/chat/completions); anthropic ids use the mantle
 * anthropic-messages lane (/anthropic/v1/messages). Context/max-out are PLACEHOLDERS;
 * thinking/images are HEURISTIC from the id — capability-probe is the source of truth.
 * Id corrections vs the operator's console list (aws bedrock list-foundation-models,
 * 2026-07-03): haiku needs the dated v1:0 id; gemma-4-31b and gpt-5.5/5.4 do not
 * exist on Bedrock — nearest ACTIVE models substituted (gemma-3-27b-it, gpt-oss-*).
 */
export const BEDROCK_SHEET: readonly SheetModel[] = [
  { provider: "aws-bedrock", model: "deepseek.v3.1", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "deepseek.v3.2", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "google.gemma-3-12b-it", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock", model: "google.gemma-3-27b-it", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock", model: "google.gemma-3-4b-it", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock-oai", model: "google.gemma-4-26b-a4b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock-oai", model: "google.gemma-4-31b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock-oai", model: "google.gemma-4-e2b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock", model: "minimax.minimax-m2", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "minimax.minimax-m2.1", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "minimax.minimax-m2.5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "mistral.devstral-2-123b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "mistral.magistral-small-2509", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "mistral.ministral-3-14b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "mistral.ministral-3-3b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "mistral.ministral-3-8b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "mistral.mistral-large-3-675b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "mistral.voxtral-mini-3b-2507", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock", model: "mistral.voxtral-small-24b-2507", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock", model: "moonshotai.kimi-k2-thinking", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "moonshotai.kimi-k2.5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "nvidia.nemotron-nano-12b-v2", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "nvidia.nemotron-nano-3-30b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "nvidia.nemotron-nano-9b-v2", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "nvidia.nemotron-super-3-120b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-oai", model: "openai.gpt-5.4", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-oai", model: "openai.gpt-5.4-2026-03-05", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-oai", model: "openai.gpt-5.5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-oai", model: "openai.gpt-5.5-2026-04-23", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "openai.gpt-oss-120b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "openai.gpt-oss-20b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "openai.gpt-oss-safeguard-120b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "openai.gpt-oss-safeguard-20b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-235b-a22b-2507", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-32b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-coder-30b-a3b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-coder-480b-a35b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-coder-next", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-next-80b-a3b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "qwen.qwen3-vl-235b-a22b-instruct", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: true },
  { provider: "aws-bedrock", model: "writer.palmyra-vision-7b", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: true },
  { provider: "aws-bedrock-oai", model: "xai.grok-4.3", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "zai.glm-4.6", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: false, images: false },
  { provider: "aws-bedrock", model: "zai.glm-4.7", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "zai.glm-4.7-flash", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock", model: "zai.glm-5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-anthropic", model: "anthropic.claude-fable-5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-anthropic", model: "anthropic.claude-haiku-4-5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-anthropic", model: "anthropic.claude-opus-4-7", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-anthropic", model: "anthropic.claude-opus-4-8", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false },
  { provider: "aws-bedrock-anthropic", model: "anthropic.claude-sonnet-5", contextTokens: 200 * K, maxOutputTokens: 32 * K, thinking: true, images: false }
] as const;

export function sheetModelsFor(provider: string): readonly SheetModel[] {
  return MODEL_SHEET.filter((row) => row.provider === provider);
}
