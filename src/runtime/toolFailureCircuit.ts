/**
 * Per-turn tool failure circuit.
 * Counts failures within a turn; opens when max reached to halt auto-retries.
 * Reset on turn end or explicit reset / success.
 */

export interface ToolFailureCircuitConfig {
  maxFailuresPerTurn?: number;
}

export interface ToolFailureCircuit {
  recordSuccess(): void;
  recordFailure(): void;
  isOpen(): boolean;
  resetTurn(): void;
}

export function createToolFailureCircuit(
  config: ToolFailureCircuitConfig = {}
): ToolFailureCircuit {
  const max = config.maxFailuresPerTurn ?? 3;
  let failures = 0;

  return {
    recordSuccess() {
      failures = 0;
    },
    recordFailure() {
      failures += 1;
    },
    isOpen(): boolean {
      return failures >= max;
    },
    resetTurn() {
      failures = 0;
    },
  };
}
