import {
  AgentReadinessScoreSchema,
  AgentReadinessSignalsSchema,
  type AgentReadinessGap,
  type AgentReadinessScore,
  type AgentReadinessSignals
} from "./agentReadinessScoreSchema.js";

const SIGNALS: readonly { readonly key: keyof AgentReadinessSignals; readonly gap: AgentReadinessGap }[] = [
  { key: "hasTestScript", gap: "test-script" },
  { key: "hasAgentsFile", gap: "agents-file" },
  { key: "hasCiConfig", gap: "ci-config" },
  { key: "hasSandboxFriendlyScripts", gap: "sandbox-friendly-scripts" }
];

/**
 * Scores static project signals for agent readiness without reading the filesystem
 * or invoking commands. Callers collect signals before using the pure scorer.
 */
export function scoreAgentReadiness(signals: AgentReadinessSignals): AgentReadinessScore {
  const parsedSignals = AgentReadinessSignalsSchema.parse(signals);
  const gaps = SIGNALS.filter(({ key }) => !parsedSignals[key]).map(({ gap }) => gap);

  return AgentReadinessScoreSchema.parse({
    level: SIGNALS.length - gaps.length,
    gaps
  });
}
