import { existsSync } from "node:fs";

export interface StaticQualityArtifact {
  readonly name?: string;
  readonly description?: string;
  readonly path?: string;
}

export interface StaticQualityScore {
  readonly score: number;
  readonly checks: {
    readonly name: boolean;
    readonly description: boolean;
    readonly pathExists: boolean;
  };
}

const NAME_WEIGHT = 34;
const DESCRIPTION_WEIGHT = 33;
const PATH_WEIGHT = 33;

/**
 * Scores the minimum structure required for a usable skill or plugin artifact.
 * Each check is independent so incomplete artifacts receive a stable partial score.
 */
export function score(artifact: StaticQualityArtifact): StaticQualityScore {
  const checks = {
    name: hasText(artifact.name),
    description: hasText(artifact.description),
    pathExists: pathExists(artifact.path)
  };

  return {
    score:
      (checks.name ? NAME_WEIGHT : 0) +
      (checks.description ? DESCRIPTION_WEIGHT : 0) +
      (checks.pathExists ? PATH_WEIGHT : 0),
    checks
  };
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function pathExists(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0 && existsSync(value);
}
