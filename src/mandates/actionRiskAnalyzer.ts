import { analyzeActionRisk, type ActionRisk } from "./actionRiskRules.js";

/**
 * Pre-tool action risk analyzer (F39).
 *
 * This is a thin wrapper around the static risk rules. It produces a
 * low|medium|high|hard-limit classification with reasons. The intended
 * integration point is the mandate evaluation path, but that wiring is outside
 * this file's scope.
 */

export interface ActionRiskAnalyzer {
  /**
   * Analyze a tool call and return its risk classification.
   * Unknown/high-risk inputs are never classified as safe by default.
   */
  analyze(toolId: string, args: unknown): ActionRisk;
}

/** Default analyzer: uses the static rule set. */
export function createActionRiskAnalyzer(): ActionRiskAnalyzer {
  return {
    analyze: (toolId, args) => analyzeActionRisk(toolId, args)
  };
}

/**
 * Synchronous convenience helper for callers that only need the level.
 */
export function actionRiskLevel(toolId: string, args: unknown): ActionRisk["level"] {
  return analyzeActionRisk(toolId, args).level;
}

export { analyzeActionRisk };
export type { ActionRisk } from "./actionRiskRules.js";
