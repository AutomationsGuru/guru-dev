import { z } from "zod";

export const HonchoPeerSchema = z.enum(["user", "ai"]);
export type HonchoPeer = z.infer<typeof HonchoPeerSchema>;

export const HonchoReasoningLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type HonchoReasoningLevel = z.infer<typeof HonchoReasoningLevelSchema>;

export const HonchoConfigSchema = z
  .object({
    /** Disabled is the honest default until the operator explicitly opts in. */
    enabled: z.boolean().default(false),
    /** Env-var NAME only; values never land in config, logs, or status output. */
    apiKeyEnvVar: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/).default("HONCHO_API_KEY"),
    workspaceId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).default("guru-memory"),
    userPeerId: z.string().trim().min(1).default("operator"),
    agentPeerId: z.string().trim().min(1).default("guru"),
    baseUrl: z.string().trim().url().optional(),
    defaultPeer: HonchoPeerSchema.default("user"),
    /** Kept for compatibility with the old in-memory test double; real runtime follows enabled. */
    writeEnabled: z.boolean().default(false),
    /** Kept for compatibility with the old in-memory test double. */
    requiredEnvNames: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    timeoutMs: z.number().int().positive().default(30000)
  })
  .strict();
export type HonchoConfig = z.infer<typeof HonchoConfigSchema>;

export const HonchoReadinessStatusSchema = z.enum(["ready", "read-only", "missing-env", "disabled", "offline", "error", "not-implemented"]);
export type HonchoReadinessStatus = z.infer<typeof HonchoReadinessStatusSchema>;

export const HonchoStatusSchema = z
  .object({
    status: HonchoReadinessStatusSchema,
    workspaceId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).optional(),
    writeEnabled: z.boolean(),
    missingEnvNames: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    summary: z.string().trim().min(1)
  })
  .strict();
export type HonchoStatus = z.infer<typeof HonchoStatusSchema>;

export const HonchoRememberRequestSchema = z
  .object({
    peer: HonchoPeerSchema.default("user"),
    fact: z.string().trim().min(1),
    context: z.string().trim().min(1).optional(),
    /** Legacy test-double compatibility; real configured Honcho follows integration config + runtime mode. */
    writeEnabled: z.boolean().default(false),
    /** Legacy test-double compatibility; real configured Honcho follows integration config + runtime mode. */
    userApproved: z.boolean().default(false)
  })
  .strict();
export type HonchoRememberRequest = z.infer<typeof HonchoRememberRequestSchema>;

export const HonchoRecallRequestSchema = z
  .object({
    query: z.string().trim().min(1),
    peer: HonchoPeerSchema.optional(),
    reasoningLevel: HonchoReasoningLevelSchema.default("minimal"),
    limit: z.number().int().positive().max(50).default(10),
    includeRaw: z.boolean().default(false)
  })
  .strict();
export type HonchoRecallRequest = z.infer<typeof HonchoRecallRequestSchema>;

export const HonchoRecallItemSchema = z
  .object({
    id: z.string().trim().min(1),
    peer: HonchoPeerSchema,
    summary: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).optional(),
    raw: z.string().trim().min(1).optional()
  })
  .strict();
export type HonchoRecallItem = z.infer<typeof HonchoRecallItemSchema>;

export const HonchoRecallResultSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "blocked"]),
    items: z.array(HonchoRecallItemSchema).default([]),
    reasonedSummary: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type HonchoRecallResult = z.infer<typeof HonchoRecallResultSchema>;

export const HonchoContextRequestSchema = z
  .object({
    peer: HonchoPeerSchema.optional(),
    maxTokens: z.number().int().positive().default(1200),
    includeRaw: z.boolean().default(false)
  })
  .strict();
export type HonchoContextRequest = z.infer<typeof HonchoContextRequestSchema>;

export const HonchoContextSnapshotSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "blocked"]),
    snapshot: z.string().trim().min(1),
    tokenEstimate: z.number().int().nonnegative().optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type HonchoContextSnapshot = z.infer<typeof HonchoContextSnapshotSchema>;

export const HonchoLogTurnRequestSchema = z
  .object({
    userSummary: z.string().trim().min(1),
    assistantSummary: z.string().trim().min(1).optional(),
    peer: HonchoPeerSchema.default("ai"),
    /** Legacy test-double compatibility; real configured Honcho follows integration config + runtime mode. */
    writeEnabled: z.boolean().default(false),
    /** Legacy test-double compatibility; real configured Honcho follows integration config + runtime mode. */
    userApproved: z.boolean().default(false)
  })
  .strict();
export type HonchoLogTurnRequest = z.infer<typeof HonchoLogTurnRequestSchema>;
