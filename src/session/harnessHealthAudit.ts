export type HarnessHealthGapId = "auth" | "tools" | "skills" | "hard-limit-config";

export interface HarnessHealthWeights {
  readonly auth: number;
  readonly tools: number;
  readonly skills: number;
  readonly hardLimitConfig: number;
}

export interface HarnessHealthSnapshot {
  readonly authReady: boolean;
  readonly toolsReady: boolean;
  readonly skillsReady: boolean;
  readonly hardLimitConfigReady: boolean;
  readonly weights: HarnessHealthWeights;
}

export interface HarnessHealthAudit {
  readonly score: number;
  readonly gaps: readonly HarnessHealthGapId[];
}

interface HealthCheck {
  readonly gapId: HarnessHealthGapId;
  readonly ready: boolean;
  readonly weight: number;
}

function usableWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/** Scores only the supplied readiness snapshot; it performs no I/O or runtime probing. */
export function scoreHarnessHealth(snapshot: HarnessHealthSnapshot): HarnessHealthAudit {
  const checks: readonly HealthCheck[] = [
    { gapId: "auth", ready: snapshot.authReady, weight: usableWeight(snapshot.weights.auth) },
    { gapId: "tools", ready: snapshot.toolsReady, weight: usableWeight(snapshot.weights.tools) },
    { gapId: "skills", ready: snapshot.skillsReady, weight: usableWeight(snapshot.weights.skills) },
    {
      gapId: "hard-limit-config",
      ready: snapshot.hardLimitConfigReady,
      weight: usableWeight(snapshot.weights.hardLimitConfig)
    }
  ];
  const totalWeight = checks.reduce((total, check) => total + check.weight, 0);
  const readyWeight = checks.reduce((total, check) => total + (check.ready ? check.weight : 0), 0);

  return {
    score: totalWeight === 0 ? 0 : Math.round((readyWeight / totalWeight) * 100),
    gaps: checks.filter((check) => !check.ready).map((check) => check.gapId)
  };
}
