/**
 * harnessHealthScore
 *
 * Pure function: deterministic health scoring for the harness readiness surface.
 * No side effects, no I/O, no mutation. Same snapshot always yields identical {score, gaps}.
 * Lightweight addition supporting P1 reliability without expanding core.
 */

export interface HarnessHealthSnapshot {
  readonly componentCount: number;
  readonly readyCount: number;
  readonly failingComponents: readonly string[];
  readonly missingEnv: readonly string[];
}

export interface HarnessHealthScore {
  readonly score: number;
  readonly gaps: readonly string[];
}

/**
 * scoreHarnessHealth
 * Computes a 0-100 score and gap list from a readiness snapshot.
 * Pure and deterministic: output depends only on input values.
 */
export function scoreHarnessHealth(snapshot: HarnessHealthSnapshot): HarnessHealthScore {
  const gaps: string[] = [];

  for (const comp of snapshot.failingComponents) {
    gaps.push(`failing-component: ${comp}`);
  }
  for (const env of snapshot.missingEnv) {
    gaps.push(`missing-env: ${env}`);
  }

  let score = 100;
  if (snapshot.componentCount > 0) {
    const ratio = snapshot.readyCount / snapshot.componentCount;
    score = Math.floor(ratio * 100);
  }

  // Penalize for gaps but keep within 0-100; empty gaps + full ready forces 100
  if (gaps.length > 0) {
    score = Math.max(0, score - gaps.length * 10);
  } else if (snapshot.readyCount === snapshot.componentCount) {
    score = 100;
  }

  return {
    score,
    gaps: [...gaps]
  };
}
