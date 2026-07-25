import { describe, it, expect } from 'vitest';
import { invokeSub, bindSet, RunContext, WorkflowTarget } from '../../../src/extensions/workflow/compose.js';

describe('Workflow Compose & Bind', () => {
  const baseCtx: RunContext = {
    state: Object.freeze({
      a: 10,
      b: "hello",
      deep: { nested: { $ref: "a" } }
    }),
    maxDepth: 5
  };

  describe('invokeSub', () => {
    it('should map flat inputs correctly', () => {
      const target: WorkflowTarget = { id: 'wf1' };
      const mapping = {
        in1: { $ref: 'a' },
        in2: 'static'
      };

      const result = invokeSub(target, mapping, baseCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowId).toBe('wf1');
        expect(result.data.inputs).toEqual({ in1: 10, in2: 'static' });
        expect(Object.isFrozen(result.data.inputs)).toBe(true);
      }
    });

    it('should fail on missing required inputs', () => {
      const target: WorkflowTarget = { id: 'wf1', requiredInputs: new Set(['req1', 'req2']) };
      const mapping = { req1: 1 };

      const result = invokeSub(target, mapping, baseCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Missing required input: req2/);
      }
    });

    it('should resolve deep references and array elements', () => {
      const target: WorkflowTarget = { id: 'wf1' };
      const mapping = {
        data: [{ $ref: 'deep' }, { $ref: 'b' }]
      };

      const result = invokeSub(target, mapping, baseCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.inputs).toEqual({
          data: [{ nested: 10 }, "hello"]
        });
      }
    });

    it('should reject cycles', () => {
      const cycleCtx: RunContext = {
        state: Object.freeze({
          a: { $ref: 'b' },
          b: { $ref: 'a' }
        }),
        maxDepth: 5
      };

      const target: WorkflowTarget = { id: 'wf1' };
      const result = invokeSub(target, { in1: { $ref: 'a' } }, cycleCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Cycle detected resolving reference: a/);
      }
    });

    it('should reject deep nesting exceeding max depth', () => {
      const shallowCtx: RunContext = {
        state: Object.freeze({ a: 1 }),
        maxDepth: 1
      };

      const target: WorkflowTarget = { id: 'wf1' };
      const result = invokeSub(target, { in1: { deep: { deeper: { $ref: 'a' } } } }, shallowCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Mapping depth exceeded max depth/);
      }
    });
  });

  describe('bindSet', () => {
    it('should bind new values and freeze new state', () => {
      const result = bindSet(baseCtx, { newKey: { $ref: 'b' }, staticKey: 42 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toEqual({
          a: 10,
          b: "hello",
          deep: { nested: { $ref: "a" } },
          newKey: "hello",
          staticKey: 42
        });
        expect(Object.isFrozen(result.data.state)).toBe(true);
      }
    });

    it('should enforce declared-key checks when allowedBindKeys is set', () => {
      const strictCtx: RunContext = {
        ...baseCtx,
        allowedBindKeys: new Set(['valid1', 'valid2'])
      };

      const good = bindSet(strictCtx, { valid1: 1 });
      expect(good.success).toBe(true);

      const bad = bindSet(strictCtx, { invalidKey: 1 });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(bad.error).toMatch(/Key 'invalidKey' is not in allowed bind keys/);
      }
    });

    it('should propagate mapping failures', () => {
      const result = bindSet(baseCtx, { val: { $ref: 'nonexistent' } });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Reference not found in context/);
      }
    });
  });
});
