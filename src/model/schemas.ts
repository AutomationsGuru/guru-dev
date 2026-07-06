import { z } from "zod";

export const OpenAiCompatiblePlannerModelConfigSchema = z
  .object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.string().trim().url().refine(allowsSecureRemoteUrl, {
      message: "baseUrl must use HTTPS except for localhost endpoints."
    }),
    model: z.string().trim().min(1),
    apiKeyEnvVar: z.string().trim().min(1).regex(/^[A-Z_][A-Z0-9_]*$/u),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
    temperature: z.number().min(0).max(2).default(0)
  })
  .strict();
export type OpenAiCompatiblePlannerModelConfig = z.infer<typeof OpenAiCompatiblePlannerModelConfigSchema>;

export const PlannerModelConfigSchema = OpenAiCompatiblePlannerModelConfigSchema;
export type PlannerModelConfig = z.infer<typeof PlannerModelConfigSchema>;

function allowsSecureRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);

    return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
