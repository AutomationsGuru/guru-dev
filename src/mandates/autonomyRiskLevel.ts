import { z } from "zod";

import {
  COMMAND_RISK_ORDER,
  CommandRiskClassSchema,
  classifyCommandRisk,
  commandRiskRank,
  type CommandRiskClass
} from "./commandRiskClass.js";

/** Session autonomy levels, ordered from no mutation to broad routine autonomy. */
export const AutonomyRiskLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type AutonomyRiskLevel = z.infer<typeof AutonomyRiskLevelSchema>;

export const AUTONOMY_RISK_LEVEL_ORDER: Readonly<Record<AutonomyRiskLevel, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3
};

export { CommandRiskClassSchema, classifyCommandRisk, commandRiskRank };
export type { CommandRiskClass };

/** Return the numeric ordering used for `risk <= level` comparisons. */
export function autonomyRiskLevelRank(level: AutonomyRiskLevel): number {
  return AUTONOMY_RISK_LEVEL_ORDER[level];
}

/**
 * A call may auto-run only when its risk is within the selected level. Hard
 * limits are checked first and are never auto-approved, including at `high`.
 */
export function mayAutoRun(level: AutonomyRiskLevel, risk: CommandRiskClass): boolean {
  const parsedLevel = AutonomyRiskLevelSchema.safeParse(level);
  const parsedRisk = CommandRiskClassSchema.safeParse(risk);
  if (!parsedLevel.success || !parsedRisk.success) return false;
  if (parsedRisk.data === "hard-limit") return false;
  return COMMAND_RISK_ORDER[parsedRisk.data] <= AUTONOMY_RISK_LEVEL_ORDER[parsedLevel.data];
}

/**
 * Classify and gate in one call for tool adapters that do not need the
 * intermediate risk class. This remains orthogonal to plan-only posture.
 */
export function mayAutoRunCommand(level: AutonomyRiskLevel, toolName: string, commandHint?: string): boolean {
  return mayAutoRun(level, classifyCommandRisk(toolName, commandHint));
}
