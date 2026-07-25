import { z } from 'zod';

/**
 * Configuration schema for the tool failure circuit breaker.
 */
export const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().default(5),
  cooldownMs: z.number().int().positive().default(30000),
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

/**
 * Internal state for a single tool's circuit.
 */
interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number | null;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

/**
 * ToolFailCircuitBreaker implements a per-tool circuit breaker pattern.
 * - CLOSED: normal operation, calls allowed.
 * - OPEN: too many failures, calls blocked until cooldown.
 * - HALF_OPEN: cooldown elapsed, one probe call allowed to test recovery.
 */
export class ToolFailCircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = CircuitBreakerConfigSchema.parse(config);
  }

  /**
   * Record a successful tool call. Resets failure count and closes the circuit.
   */
  recordSuccess(toolName: string): void {
    const circuit = this.getOrCreateCircuit(toolName);
    circuit.consecutiveFailures = 0;
    circuit.lastFailureTime = null;
    circuit.state = 'CLOSED';
  }

  /**
   * Record a failed tool call. Increments consecutive failures.
   * Opens the circuit if threshold is reached.
   * If in HALF_OPEN, failure immediately re-opens the circuit.
   */
  recordFailure(toolName: string): void {
    const circuit = this.getOrCreateCircuit(toolName);
    circuit.consecutiveFailures += 1;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === 'HALF_OPEN' || circuit.consecutiveFailures >= this.config.failureThreshold) {
      circuit.state = 'OPEN';
    }
  }

  /**
   * Check whether a call to the given tool is currently permitted.
   * - In OPEN state, transitions to HALF_OPEN (and permits) once cooldown has elapsed.
   * - In HALF_OPEN, permits a single probe call.
   */
  mayCall(toolName: string): boolean {
    const circuit = this.getOrCreateCircuit(toolName);

    if (circuit.state === 'CLOSED') {
      return true;
    }

    if (circuit.state === 'OPEN') {
      const now = Date.now();
      if (circuit.lastFailureTime !== null && now - circuit.lastFailureTime >= this.config.cooldownMs) {
        circuit.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }

    if (circuit.state === 'HALF_OPEN') {
      return true;
    }

    return true;
  }

  /**
   * Test helper: expose internal state for assertions.
   */
  getState(toolName: string): CircuitState {
    return this.getOrCreateCircuit(toolName);
  }

  private getOrCreateCircuit(toolName: string): CircuitState {
    if (!this.circuits.has(toolName)) {
      this.circuits.set(toolName, {
        consecutiveFailures: 0,
        lastFailureTime: null,
        state: 'CLOSED',
      });
    }
    return this.circuits.get(toolName)!;
  }
}
