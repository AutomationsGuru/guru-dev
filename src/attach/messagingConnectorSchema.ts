import { z } from 'zod';

export const messagingConnectorConfigSchema = z.object({
  parityGap: z.string().min(1, "parityGap ID is required to enable a connector"),
  // Extensible for future config options (endpoints, credentials, etc.)
});

export type MessagingConnectorConfig = z.infer<typeof messagingConnectorConfigSchema>;
