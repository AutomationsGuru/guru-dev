import { z } from "zod";

/** Environment-variable names are references only; secrets never live in config. */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

export const WebhookWakeConfigSchema = z
  .object({
    /** Webhook wake is off by default — opt-in per deployment. */
    enabled: z.boolean().default(false),
    /** Name of the environment variable holding the HMAC SHA-256 secret. */
    secretEnvVar: z
      .string()
      .trim()
      .regex(ENVIRONMENT_VARIABLE_NAME)
      .default("GURUHARNESS_WEBHOOK_SECRET")
  })
  .strict();
export type WebhookWakeConfig = z.infer<typeof WebhookWakeConfigSchema>;

export const DEFAULT_WEBHOOK_WAKE_CONFIG: WebhookWakeConfig = {
  enabled: false,
  secretEnvVar: "GURUHARNESS_WEBHOOK_SECRET"
};

/** The inbound webhook body — minimal: just the objective id to wake. */
export const WebhookWakeInputSchema = z
  .object({
    objectiveId: z.string().trim().min(1)
  })
  .strict();
export type WebhookWakeInput = z.infer<typeof WebhookWakeInputSchema>;

/** The enqueued wake job struct consumed by fleet/schedule. */
export const WebhookWakeJobSchema = z
  .object({
    objectiveId: z.string().trim().min(1),
    /** ISO-8601 timestamp set by the handler at receive time. */
    receivedAt: z.string().datetime(),
    source: z.literal("webhook")
  })
  .strict();
export type WebhookWakeJob = z.infer<typeof WebhookWakeJobSchema>;
