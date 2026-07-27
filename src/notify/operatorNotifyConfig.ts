import { z } from "zod";

export const OperatorNotifyChannelSchema = z.enum(["log", "bell", "desktop"]);
export type OperatorNotifyChannel = z.infer<typeof OperatorNotifyChannelSchema>;

export const OperatorNotifyConfigSchema = z
  .object({
    /** Opt-in operator notification. Default off so a silent harness stays silent. */
    enabled: z.boolean().default(false),
    /** Active channels. Desktop is optional and requires an injected notifier. */
    channels: z.array(OperatorNotifyChannelSchema).default(["log"])
  })
  .strict();
export type OperatorNotifyConfig = z.infer<typeof OperatorNotifyConfigSchema>;
export type OperatorNotifyConfigInput = z.input<typeof OperatorNotifyConfigSchema>;

export const DEFAULT_OPERATOR_NOTIFY_CONFIG: OperatorNotifyConfig = OperatorNotifyConfigSchema.parse({});
