import { z } from "zod";

/**
 * The small, session-scoped approval vocabulary. Tool adapters classify a call
 * once; the approval matrix decides whether that class may pass silently.
 */
export const AutoApproveClassSchema = z.enum([
  "read",
  "write",
  "shell-safe",
  "shell-risk",
  "network",
  "destructive",
  "spend",
  "secret-edge",
  "auth-edge"
]);
export type AutoApproveClass = z.infer<typeof AutoApproveClassSchema>;
/** Compatibility name for callers that describe these as tool classes. */
export type AutoApproveToolClass = AutoApproveClass;

/** Classes which must always reach an approval gate. */
export const HARD_LIMIT_AUTO_APPROVE_CLASSES = ["destructive", "spend", "secret-edge", "auth-edge"] as const satisfies readonly AutoApproveClass[];
/** Shell-risk is not itself a constitutional verb, but it is never silent. */
export const GATED_AUTO_APPROVE_CLASSES = ["shell-risk", ...HARD_LIMIT_AUTO_APPROVE_CLASSES] as const satisfies readonly AutoApproveClass[];

export const AutoApproveConfigSchema = z
  .object({
    read: z.boolean().default(false),
    write: z.boolean().default(false),
    "shell-safe": z.boolean().default(false),
    "shell-risk": z.boolean().default(false),
    network: z.boolean().default(false),
    destructive: z.boolean().default(false),
    spend: z.boolean().default(false),
    "secret-edge": z.boolean().default(false),
    "auth-edge": z.boolean().default(false)
  })
  .strict();

export type AutoApproveConfig = z.infer<typeof AutoApproveConfigSchema>;

/**
 * YOLO's ordinary permission baseline. It is intentionally explicit rather
 * than an all-true wildcard: shell-risk and every hard-limit class still gate.
 */
export const DEFAULT_AUTO_APPROVE_CONFIG: AutoApproveConfig = AutoApproveConfigSchema.parse({
  read: true,
  write: true,
  "shell-safe": true,
  network: true
});
