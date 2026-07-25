import { z } from "zod";

export const AgentReadinessGapSchema = z.enum([
  "test-script",
  "agents-file",
  "ci-config",
  "sandbox-friendly-scripts"
]);
export type AgentReadinessGap = z.infer<typeof AgentReadinessGapSchema>;

export const AgentReadinessSignalsSchema = z
  .object({
    hasTestScript: z.boolean(),
    hasAgentsFile: z.boolean(),
    hasCiConfig: z.boolean(),
    hasSandboxFriendlyScripts: z.boolean()
  })
  .strict();
export type AgentReadinessSignals = z.infer<typeof AgentReadinessSignalsSchema>;

export const AgentReadinessLevelSchema = z.number().int().min(0).max(4);
export type AgentReadinessLevel = z.infer<typeof AgentReadinessLevelSchema>;

export const AgentReadinessScoreSchema = z
  .object({
    level: AgentReadinessLevelSchema,
    gaps: z.array(AgentReadinessGapSchema)
  })
  .strict();
export type AgentReadinessScore = z.infer<typeof AgentReadinessScoreSchema>;
