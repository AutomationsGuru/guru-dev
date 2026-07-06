import { z } from "zod";

import { VerdictSchema } from "../core/types.js";

export const ReadinessCategorySchema = z.enum([
  "runtime",
  "validation",
  "direct-provider",
  "router",
  "mcp",
  "honcho",
  "provider-cli",
  "desktop",
  "local-service",
  "repo-governance"
]);
export type ReadinessCategory = z.infer<typeof ReadinessCategorySchema>;

export const ReadinessStatusSchema = z.enum([
  "ready",
  "ready-unverified",
  "missing-env",
  "missing-config",
  "missing-command",
  "offline",
  "blocked",
  "failing",
  "not-implemented",
  "excluded-by-policy"
]);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

export const EnvNameSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, "Expected an environment variable name, not a value.");

export const ReadinessRowSchema = z
  .object({
    id: z.string().trim().min(1),
    category: ReadinessCategorySchema,
    title: z.string().trim().min(1),
    status: ReadinessStatusSchema,
    verdict: VerdictSchema,
    ownerModule: z.string().trim().min(1),
    missingEnvNames: z.array(EnvNameSchema).default([]),
    evidence: z.array(z.string().trim().min(1)).default([]),
    summary: z.string().trim().min(1),
    nextAction: z.string().trim().min(1).optional()
  })
  .strict();
export type ReadinessRow = z.infer<typeof ReadinessRowSchema>;

export const ValidationCheckStatusSchema = z.enum(["passed", "failed", "not-run", "blocked"]);
export type ValidationCheckStatus = z.infer<typeof ValidationCheckStatusSchema>;

export const ValidationCheckRowSchema = z
  .object({
    name: z.string().trim().min(1),
    command: z.array(z.string().trim().min(1)).min(1),
    status: ValidationCheckStatusSchema,
    exitCode: z.number().int().optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type ValidationCheckRow = z.infer<typeof ValidationCheckRowSchema>;

export const ReadinessReportSchema = z
  .object({
    generatedAt: z.string().datetime(),
    runtimeName: z.string().trim().min(1),
    runtimeVersion: z.string().trim().min(1).optional(),
    verdict: VerdictSchema,
    rows: z.array(ReadinessRowSchema),
    validationChecks: z.array(ValidationCheckRowSchema).default([]),
    summary: z.string().trim().min(1)
  })
  .strict();
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;
