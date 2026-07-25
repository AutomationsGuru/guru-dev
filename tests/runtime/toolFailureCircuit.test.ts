import { describe, it, expect } from 'vitest';
import { createToolFailureCircuit } from '../../src/runtime/toolFailureCircuit.js';

describe('ToolFailureCircuit', () => {
  it('continues under the failure limit', () => {
    const circuit = createToolFailureCircuit({ maxFailuresPerTurn: 3 });
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(false);
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(false);
  });

  it('opens at the limit', () => {
    const circuit = createToolFailureCircuit({ maxFailuresPerTurn: 3 });
    circuit.recordFailure();
    circuit.recordFailure();
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(true);
  });

  it('reset clears the circuit', () => {
    const circuit = createToolFailureCircuit({ maxFailuresPerTurn: 3 });
    circuit.recordFailure();
    circuit.recordFailure();
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(true);
    circuit.resetTurn();
    expect(circuit.isOpen()).toBe(false);
  });

  it('success resets failure count', () => {
    const circuit = createToolFailureCircuit({ maxFailuresPerTurn: 3 });
    circuit.recordFailure();
    circuit.recordFailure();
    circuit.recordSuccess();
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(false);
  });

  it('uses default max of 3', () => {
    const circuit = createToolFailureCircuit();
    for (let i = 0; i < 2; i++) circuit.recordFailure();
    expect(circuit.isOpen()).toBe(false);
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(true);
  });
});
