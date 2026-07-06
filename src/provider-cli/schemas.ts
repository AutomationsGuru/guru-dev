import { z } from "zod";

export const ProviderCliIdSchema = z.enum([
  "codex",
  "claude",
  "agy",
  "opencode",
  "grok",
  "mavis",
  "minimax",
  "gcloud",
  "gsutil",
  "bq",
  "cursor",
  "honcho-admin"
]);
export type ProviderCliId = z.infer<typeof ProviderCliIdSchema>;

export const ProviderCliCommandPolicySchema = z.enum(["status-only", "explicit-run-allowed", "blocked"]);
export type ProviderCliCommandPolicy = z.infer<typeof ProviderCliCommandPolicySchema>;

export const ProviderCliConfigSchema = z
  .object({
    id: ProviderCliIdSchema,
    commandName: z.string().trim().min(1),
    statusArgs: z.array(z.string()).default(["--version"]),
    requiredEnvNames: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    policy: ProviderCliCommandPolicySchema.default("status-only"),
    timeoutMs: z.number().int().positive().default(30000),
    notes: z.string().trim().min(1).optional()
  })
  .strict();
export type ProviderCliConfig = z.infer<typeof ProviderCliConfigSchema>;

export const ProviderCliStatusSchema = z.enum(["ready", "missing-command", "missing-env", "disabled", "error", "not-implemented"]);
export type ProviderCliStatus = z.infer<typeof ProviderCliStatusSchema>;

export const ProviderCliStatusReportSchema = z
  .object({
    id: ProviderCliIdSchema,
    status: ProviderCliStatusSchema,
    commandName: z.string().trim().min(1),
    version: z.string().trim().min(1).optional(),
    missingEnvNames: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    summary: z.string().trim().min(1)
  })
  .strict();
export type ProviderCliStatusReport = z.infer<typeof ProviderCliStatusReportSchema>;

export const ProviderCliRunRequestSchema = z
  .object({
    id: ProviderCliIdSchema,
    prompt: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    dryRun: z.boolean().default(true),
    userApproved: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(120000),
    redactOutput: z.boolean().default(true)
  })
  .strict();
export type ProviderCliRunRequest = z.infer<typeof ProviderCliRunRequestSchema>;

export const ProviderCliRunResultSchema = z
  .object({
    id: ProviderCliIdSchema,
    status: z.enum(["succeeded", "failed", "blocked", "dry-run"]),
    exitCode: z.number().int().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    redacted: z.boolean().default(true),
    summary: z.string().trim().min(1)
  })
  .strict();
export type ProviderCliRunResult = z.infer<typeof ProviderCliRunResultSchema>;
