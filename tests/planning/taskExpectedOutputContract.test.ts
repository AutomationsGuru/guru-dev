import { describe, it, expect } from 'vitest';
import { validateTask } from '../../src/planning/taskExpectedOutputContract.js';

describe('taskExpectedOutputContract', () => {
  it('fails for missing expectedOutput', () => {
    const incompleteTask = {
      id: 't-1',
      title: 'Example task',
      // expectedOutput intentionally omitted to trigger RED
    };

    expect(() => validateTask(incompleteTask)).toThrow(/expectedOutput/);
  });
});
