import { describe, it, expect } from 'vitest';
import { validateTask, BiteSizeTask } from '../../src/planning/biteSizeTaskPlan.js';

describe('BiteSize Task Plan Validator', () => {
  it('passes a complete valid task', () => {
    const task: BiteSizeTask = {
      description: 'Implement validator logic',
      path: 'src/planning/biteSizeTaskPlan.ts',
      verification: 'Run tests and ensure they pass'
    };
    const result = validateTask(task);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when path is missing', () => {
    const task: Partial<BiteSizeTask> = {
      description: 'Implement validator logic',
      verification: 'Run tests and ensure they pass'
    };
    const result = validateTask(task);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Task is missing a required path.');
  });

  it('fails when verification is missing', () => {
    const task: Partial<BiteSizeTask> = {
      description: 'Implement validator logic',
      path: 'src/planning/biteSizeTaskPlan.ts'
    };
    const result = validateTask(task);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Task is missing a required verification step.');
  });

  it('fails when both path and verification are missing', () => {
    const task: Partial<BiteSizeTask> = {
      description: 'Implement validator logic'
    };
    const result = validateTask(task);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Task is missing a required path.');
    expect(result.errors).toContain('Task is missing a required verification step.');
  });
});
