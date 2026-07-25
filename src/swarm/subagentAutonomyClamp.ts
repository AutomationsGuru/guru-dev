export type AutonomyLevel = "off" | "low" | "medium" | "high";

export interface ParentAutonomyConfig {
  level: AutonomyLevel;
  spec: boolean;
}

const autonomyRank: Record<AutonomyLevel, number> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3
};

function lowerLevel(left: AutonomyLevel, right: AutonomyLevel): AutonomyLevel {
  return autonomyRank[left] <= autonomyRank[right] ? left : right;
}

/**
 * Resolves a child's requested autonomy against its parent and organization
 * ceilings. A specification-mode parent disables child autonomy entirely.
 */
export function clamp(parent: ParentAutonomyConfig, childPref: AutonomyLevel | undefined, orgMax: AutonomyLevel): AutonomyLevel {
  if (parent.spec) {
    return "off";
  }

  const desired = childPref ?? parent.level;
  return lowerLevel(lowerLevel(desired, parent.level), orgMax);
}
