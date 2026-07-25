export interface StaticLayerCheck {
  readonly name: string;
  readonly check: () => boolean;
}

export interface StaticLayerResult {
  readonly name: string;
  readonly passed: boolean;
}

export interface StaticLayersResult {
  readonly passed: boolean;
  readonly results: readonly StaticLayerResult[];
}

/** Runs deterministic plugin checks and preserves their declared evaluation order. */
export function runLayers(checks: readonly StaticLayerCheck[]): StaticLayersResult {
  const results = checks.map(({ name, check }) => ({ name, passed: check() }));

  return {
    passed: results.every((result) => result.passed),
    results
  };
}
