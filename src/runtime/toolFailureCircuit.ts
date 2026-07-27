/**
 * ToolFailureCircuit - Circuit breaker for tool failures in GuruHarness loops.
 * Implements CLOSED / OPEN / HALF_OPEN states with configurable thresholds,
 * automatic recovery timeout, and per-tool tracking.
 *
 * Follows the VISION: protects loops from repeated tool failures by failing fast
 * when a tool exceeds failureThreshold, then probing recovery in HALF_OPEN.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ToolFailureCircuitConfig {
  failureThreshold?: number;      // failures before opening (default 5)
  recoveryTimeout?: number;       // ms before HALF_OPEN probe (default 30000)
  successThreshold?: number;      // successes in HALF_OPEN to close (default 2)
  halfOpenMaxAttempts?: number;   // optional cap on probes (default = successThreshold)
}

interface Circuit {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  openTime: number | null;
  lastStateChange: number;
}

export class ToolFailureCircuit {
  private circuits = new Map<string, Circuit>();
  private readonly config: Required<ToolFailureCircuitConfig>;

  constructor(config: ToolFailureCircuitConfig = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      recoveryTimeout: config.recoveryTimeout ?? 30000,
      successThreshold: config.successThreshold ?? 2,
      halfOpenMaxAttempts: config.halfOpenMaxAttempts ?? (config.successThreshold ?? 2),
    };
  }

  private getOrCreate(toolName: string): Circuit {
    if (!this.circuits.has(toolName)) {
      this.circuits.set(toolName, {
        state: 'CLOSED',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: null,
        openTime: null,
        lastStateChange: Date.now(),
      });
    }
    return this.circuits.get(toolName)!;
  }

  private transition(circuit: Circuit, newState: CircuitState, toolName?: string): void {
    if (circuit.state !== newState) {
      circuit.state = newState;
      circuit.lastStateChange = Date.now();
      if (newState === 'OPEN') {
        circuit.openTime = Date.now();
      } else if (newState === 'CLOSED') {
        circuit.openTime = null;
        circuit.failureCount = 0;
        circuit.successCount = 0;
      } else if (newState === 'HALF_OPEN') {
        circuit.successCount = 0;
      }
    }
  }

  private checkRecovery(circuit: Circuit): void {
    if (circuit.state === 'OPEN' && circuit.openTime) {
      const elapsed = Date.now() - circuit.openTime;
      if (elapsed >= this.config.recoveryTimeout) {
        this.transition(circuit, 'HALF_OPEN');
      }
    }
  }

  recordFailure(toolName: string, error?: Error): void {
    const circuit = this.getOrCreate(toolName);
    this.checkRecovery(circuit);

    circuit.failureCount++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === 'HALF_OPEN') {
      // Failure during probe → back to OPEN
      this.transition(circuit, 'OPEN');
      return;
    }

    if (circuit.state === 'CLOSED' && circuit.failureCount >= this.config.failureThreshold) {
      this.transition(circuit, 'OPEN');
    }
  }

  recordSuccess(toolName: string): void {
    const circuit = this.getOrCreate(toolName);
    this.checkRecovery(circuit);

    if (circuit.state === 'HALF_OPEN') {
      circuit.successCount++;
      if (circuit.successCount >= this.config.successThreshold) {
        this.transition(circuit, 'CLOSED');
      }
    } else if (circuit.state === 'CLOSED') {
      // Success in closed resets failure count gradually (optional, but keeps stats clean)
      if (circuit.failureCount > 0) {
        circuit.failureCount = Math.max(0, circuit.failureCount - 1);
      }
    }
  }

  getCircuitState(toolName: string): CircuitState {
    const circuit = this.getOrCreate(toolName);
    this.checkRecovery(circuit);
    return circuit.state;
  }

  isCircuitOpen(toolName: string): boolean {
    const state = this.getCircuitState(toolName);
    return state === 'OPEN' || state === 'HALF_OPEN';
  }

  getStats(toolName: string) {
    const circuit = this.getOrCreate(toolName);
    this.checkRecovery(circuit);
    return {
      state: circuit.state,
      failures: circuit.failureCount,
      successes: circuit.successCount,
      lastFailureTime: circuit.lastFailureTime,
      openTime: circuit.openTime,
      lastStateChange: circuit.lastStateChange,
      config: { ...this.config },
    };
  }

  getAllStats() {
    const stats: Record<string, ReturnType<typeof this.getStats>> = {};
    for (const [toolName] of this.circuits) {
      stats[toolName] = this.getStats(toolName);
    }
    return stats;
  }

  reset(toolName: string): void {
    if (this.circuits.has(toolName)) {
      const circuit = this.circuits.get(toolName)!;
      circuit.state = 'CLOSED';
      circuit.failureCount = 0;
      circuit.successCount = 0;
      circuit.lastFailureTime = null;
      circuit.openTime = null;
      circuit.lastStateChange = Date.now();
    }
  }

  resetAll(): void {
    this.circuits.clear();
  }
}
