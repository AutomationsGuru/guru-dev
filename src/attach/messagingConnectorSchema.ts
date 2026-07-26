import { z } from "zod";

/** External messaging is an ATTACH-class extension, never a core dependency. */
export const MessagingConnectorIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9._-]{0,63}$/u, "Connector id must be a lowercase slug (max 64 characters).");
export type MessagingConnectorId = z.infer<typeof MessagingConnectorIdSchema>;

export const MessagingConnectorParityGapIdSchema = z.string().trim().min(1, "A parity-gap id is required for an enabled connector.");
export type MessagingConnectorParityGapId = z.infer<typeof MessagingConnectorParityGapIdSchema>;

export const MessagingConnectorMessageSchema = z
  .object({
    recipient: z.string().trim().min(1),
    text: z.string().min(1),
    threadId: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type MessagingConnectorMessage = z.infer<typeof MessagingConnectorMessageSchema>;
export type MessagingConnectorMessageInput = z.input<typeof MessagingConnectorMessageSchema>;

export const MessagingConnectorSendResultSchema = z
  .object({
    connectorId: MessagingConnectorIdSchema,
    status: z.enum(["sent", "noop", "failed"]),
    message: MessagingConnectorMessageSchema,
    summary: z.string().trim().min(1)
  })
  .strict();
export type MessagingConnectorSendResult = z.infer<typeof MessagingConnectorSendResultSchema>;

export const MessagingConnectorConfigSchema = z
  .object({
    id: MessagingConnectorIdSchema,
    enabled: z.boolean().default(false),
    parityGapId: MessagingConnectorParityGapIdSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && !value.parityGapId) {
      ctx.addIssue({
        code: "custom",
        path: ["parityGapId"],
        message: "Enabled messaging connectors require a parity-gap id."
      });
    }
  });
export type MessagingConnectorConfig = z.infer<typeof MessagingConnectorConfigSchema>;

export const MessagingConnectorStateSchema = z.enum(["disabled", "disconnected", "connected", "error"]);
export type MessagingConnectorState = z.infer<typeof MessagingConnectorStateSchema>;

export const MessagingConnectorStatusSchema = z
  .object({
    id: MessagingConnectorIdSchema,
    enabled: z.boolean(),
    parityGapId: MessagingConnectorParityGapIdSchema.optional(),
    state: MessagingConnectorStateSchema,
    summary: z.string().trim().min(1)
  })
  .strict();
export type MessagingConnectorStatus = z.infer<typeof MessagingConnectorStatusSchema>;
