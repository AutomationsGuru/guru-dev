/**
 * Tests for HarnessCapabilityMatrix.supports(feature)
 * Verifies known true/false cases from static matrix
 */

import { HarnessCapabilityMatrix, HARNESS_CAPABILITY_MATRIX } from '../../src/config/harnessCapabilityMatrix.js';

describe('HarnessCapabilityMatrix', () => {
  let matrix: HarnessCapabilityMatrix;

  beforeEach(() => {
    matrix = new HarnessCapabilityMatrix();
  });

  describe('supports(feature)', () => {
    it('should return true for known capability IDs', () => {
      expect(matrix.supports('cap_001')).toBe(true);
      expect(matrix.supports('cap_002')).toBe(true);
      expect(matrix.supports('cap_003')).toBe(true);
      expect(matrix.supports('cap_004')).toBe(true);
      expect(matrix.supports('cap_005')).toBe(true);
      expect(matrix.supports('cap_006')).toBe(true);
    });

    it('should return true for known capability names (case-insensitive)', () => {
      expect(matrix.supports('Memory Management')).toBe(true);
      expect(matrix.supports('memory management')).toBe(true);
      expect(matrix.supports('MEMORY MANAGEMENT')).toBe(true);
      expect(matrix.supports('Tool Execution')).toBe(true);
      expect(matrix.supports('Model Routing')).toBe(true);
      expect(matrix.supports('Context Compaction')).toBe(true);
      expect(matrix.supports('Agent Orchestration')).toBe(true);
      expect(matrix.supports('Vector Search')).toBe(true);
    });

    it('should return false for unknown capability IDs', () => {
      expect(matrix.supports('cap_999')).toBe(false);
      expect(matrix.supports('cap_000')).toBe(false);
      expect(matrix.supports('unknown_cap')).toBe(false);
    });

    it('should return false for unknown capability names', () => {
      expect(matrix.supports('Unknown Feature')).toBe(false);
      expect(matrix.supports('Nonexistent Capability')).toBe(false);
      expect(matrix.supports('Random Name')).toBe(false);
    });

    it('should return false for empty or whitespace input', () => {
      expect(matrix.supports('')).toBe(false);
      expect(matrix.supports('   ')).toBe(false);
      expect(matrix.supports('\t')).toBe(false);
      expect(matrix.supports('\n')).toBe(false);
    });

    it('should handle partial name matches as false (exact name required)', () => {
      expect(matrix.supports('Memory')).toBe(false);
      expect(matrix.supports('Tool')).toBe(false);
      expect(matrix.supports('Routing')).toBe(false);
    });
  });

  describe('matrix data integrity', () => {
    it('should have 6 capabilities in the static matrix', () => {
      expect(HARNESS_CAPABILITY_MATRIX.length).toBe(6);
    });

    it('should contain all expected IDs', () => {
      const ids = HARNESS_CAPABILITY_MATRIX.map(c => c.id);
      expect(ids).toContain('cap_001');
      expect(ids).toContain('cap_002');
      expect(ids).toContain('cap_003');
      expect(ids).toContain('cap_004');
      expect(ids).toContain('cap_005');
      expect(ids).toContain('cap_006');
    });

    it('should have unique IDs', () => {
      const ids = HARNESS_CAPABILITY_MATRIX.map(c => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('getCapability(feature)', () => {
    it('should return capability for valid ID', () => {
      const cap = matrix.getCapability('cap_001');
      expect(cap).toBeDefined();
      expect(cap?.name).toBe('Memory Management');
    });

    it('should return capability for valid name', () => {
      const cap = matrix.getCapability('Tool Execution');
      expect(cap).toBeDefined();
      expect(cap?.id).toBe('cap_002');
    });

    it('should return undefined for unknown feature', () => {
      expect(matrix.getCapability('nonexistent')).toBeUndefined();
    });
  });

  describe('getAllCapabilities()', () => {
    it('should return all 6 capabilities', () => {
      const all = matrix.getAllCapabilities();
      expect(all.length).toBe(6);
    });
  });
});
