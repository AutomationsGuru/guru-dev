import { z } from "zod";

import { DirectionAlignmentTaskSchema } from "../direction/hereThere.js";
import { SkillCatalogSchema, SkillDocumentSchema } from "../skills/schemas.js";

export const HarnessSessionStatusSchema = z.enum(["ready", "blocked"]);
export type HarnessSessionStatus = z.infer<typeof HarnessSessionStatusSchema>;

export const RuntimeConfigSummarySchema = z
  .object({
    status: z.enum(["loaded", "missing", "invalid"]),
    verdict: z.enum(["GREEN", "YELLOW", "RED"]),
    path: z.string(),
    diagnostics: z.array(z.string()),
    runtimeName: z.string(),
    referenceRuntime: z.string()
  })
  .strict();
export type RuntimeConfigSummary = z.infer<typeof RuntimeConfigSummarySchema>;

export const RuntimeAgentsFileSchema = z
  .object({
    path: z.string(),
    relativePath: z.string(),
    contents: z.string()
  })
  .strict();

export const RuntimeRepositoryContextSchema = z
  .object({
    repoRoot: z.string(),
    targetPath: z.string(),
    gitStatus: z.string(),
    agentsChain: z.array(RuntimeAgentsFileSchema)
  })
  .strict();
export type RuntimeRepositoryContext = z.infer<typeof RuntimeRepositoryContextSchema>;

export const RuntimeToolSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string()
  })
  .strict();
export type RuntimeToolSummary = z.infer<typeof RuntimeToolSummarySchema>;

export const RuntimePolicySummarySchema = z
  .object({
    validationCommands: z.array(z.string()),
    reviewGate: z.object({ provider: z.literal("coderabbit"), required: z.boolean() }).strict(),
    approvalPolicy: z
      .object({
        autoCommitPushPr: z.boolean(),
        allowLocalMerge: z.boolean(),
        allowForcePush: z.boolean()
      })
      .strict()
  })
  .strict();
export type RuntimePolicySummary = z.infer<typeof RuntimePolicySummarySchema>;

export const RuntimeMemoryBindingSchema = z
  .object({
    provider: z.enum(["in-memory-operational-store", "injected-operational-store"]),
    status: z.enum(["available"]),
    projectSlug: z.string()
  })
  .strict();
export type RuntimeMemoryBinding = z.infer<typeof RuntimeMemoryBindingSchema>;

export const RuntimeDirectionCheckSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["passed", "warning", "failed"]),
    summary: z.string(),
    evidence: z.array(z.string())
  })
  .strict();

export const RuntimeDirectionReportSchema = z
  .object({
    here: z.string(),
    there: z.string(),
    verdict: z.enum(["GREEN", "YELLOW", "RED"]),
    task: DirectionAlignmentTaskSchema.optional(),
    checks: z.array(RuntimeDirectionCheckSchema),
    summary: z.string()
  })
  .strict();

export const HarnessSessionSchema = z
  .object({
    id: z.string().trim().min(1),
    runtimeName: z.string().trim().min(1),
    status: HarnessSessionStatusSchema,
    startedAt: z.string().trim().min(1),
    task: DirectionAlignmentTaskSchema.nullable(),
    here: z.string().trim().min(1),
    there: z.string().trim().min(1),
    direction: RuntimeDirectionReportSchema,
    config: RuntimeConfigSummarySchema,
    repo: RuntimeRepositoryContextSchema.nullable(),
    skills: z
      .object({
        catalog: SkillCatalogSchema,
        loaded: z.array(SkillDocumentSchema)
      })
      .strict(),
    memory: RuntimeMemoryBindingSchema,
    policy: RuntimePolicySummarySchema,
    tools: z.array(RuntimeToolSummarySchema),
    blockers: z.array(z.string()),
    nextActions: z.array(z.string())
  })
  .strict();
export type HarnessSession = z.infer<typeof HarnessSessionSchema>;

export const StartHarnessSessionOptionsSchema = z
  .object({
    configPath: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    targetPath: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1).optional(),
    skillIds: z.array(z.string().trim().min(1)).default([]),
    projectSlug: z.string().trim().min(1).default("guruharness")
  })
  .strict();
export type StartHarnessSessionOptions = z.input<typeof StartHarnessSessionOptionsSchema>;
