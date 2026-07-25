import { describe, it, expect } from 'vitest';
import { computeWaves, type Task } from '../../src/planning/taskDependencyWaves.js';

describe('computeWaves', () => {
  it('returns single wave for independent tasks', () => {
    const tasks: Task[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' }
    ];
    const waves = computeWaves(tasks);
    expect(waves).toEqual([['a', 'b', 'c']]);
  });

  it('produces linear waves for chain dependency', () => {
    const tasks: Task[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] }
    ];
    const waves = computeWaves(tasks);
    expect(waves).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles diamond dependency with concurrent waves', () => {
    const tasks: Task[] = [
      { id: 'start' },
      { id: 'left', dependsOn: ['start'] },
      { id: 'right', dependsOn: ['start'] },
      { id: 'end', dependsOn: ['left', 'right'] }
    ];
    const waves = computeWaves(tasks);
    expect(waves).toEqual([['start'], ['left', 'right'], ['end']]);
  });

  it('throws on cycle', () => {
    const tasks: Task[] = [
      { id: 'x', dependsOn: ['y'] },
      { id: 'y', dependsOn: ['x'] }
    ];
    expect(() => computeWaves(tasks)).toThrow(/cycle/i);
  });

  it('handles empty input', () => {
    expect(computeWaves([])).toEqual([]);
  });
});
