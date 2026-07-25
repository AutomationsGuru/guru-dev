import { z } from "zod";

/**
 * IDEA-F73 ATTACH stub: schemas for external messaging connector config/state.
 *
 * Interface-only wave — no real provider traffic exists behind these shapes.
 * Secrets are referenced by presence-over-value (env var names), never stored;
 * the config map enforces env-var-NAME-shaped values at the schema level.
 * Enablement is schema-gated: enabled=true without parityGapId fails to parse.
 */

export const MessagingConnectorKindSchema = z.enum(["slack", "teams", "discord", "generic"]);
export type MessagingConnectorKind = z.infer<typeof MessagingConnectorKindSchema>;

export const MessagingConnectorStatusSchema = z.enum(["disabled", "ready", "enabled", "error"]);
export type MessagingConnectorStatus = z.infer<typeof MessagingConnectorStatusSchema>;

const EnvVarNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*$/u, "Expected an environment variable name, not a value.");

/**
 * Presence-over-value config map: values are env var NAMES only (e.g. a
 * tokenEnvVar-style entry maps to GURU_SLACK_TOKEN). Raw secret values and any
 * non-env-name-shaped string are rejected by the schema.
 */
export const MessagingConnectorConfigMapSchema = z.record(z.string(), EnvVarNameSchema);
export type MessagingConnectorConfigMap = z.infer<typeof MessagingConnectorConfigMapSchema>;

export const MessagingConnectorConfigSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: MessagingConnectorKindSchema,
    enabled: z.boolean().default(false),
    parityGapId: z.string().trim().min(1).optional(),
    config: MessagingConnectorConfigMapSchema.default({})
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && !value.parityGapId) {
      ctx.addIssue({
        code: "custom",
        path: ["parityGapId"],
        message: `parityGapId (e.g. "R-CL-CONNECT") is required to enable connector "${value.id}".`
      });
    }
  });
export type MessagingConnectorConfig = z.infer<typeof MessagingConnectorConfigSchema>;
/** Input shape: fields with schema defaults (enabled, config) may be omitted. */
export type MessagingConnectorConfigInput = z.input<typeof MessagingConnectorConfigSchema>;

export const MessagingConnectorStateSchema = z
  .object({
    connectorId: z.string().trim().min(1),
    status: MessagingConnectorStatusSchema,
    parityGapId: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type MessagingConnectorState = z.infer<typeof MessagingConnectorStateSchema>;

export const MessagingConnectorSendResultSchema = z
  .object({
    delivered: z.boolean(),
    reason: z.string().trim().min(1),
    connectorId: z.string().trim().min(1)
  })
  .strict();
export type MessagingConnectorSendResult = z.infer<typeof MessagingConnectorSendResultSchema>;
