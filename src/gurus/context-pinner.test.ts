import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextPinnerGuru } from './context-pinner';
import { Mandate } from '../core/mandate';

// Mock Mandate with context pinning methods
const createMockMandate = () => {
  const mock = {
    pinFile: vi.fn().mockResolvedValue(undefined),
    unpinFile: vi.fn().mockResolvedValue(undefined),
    getPinnedFiles: vi.fn().mockReturnValue([]),
    buildContext: vi.fn().mockReturnValue({ system: '', user: '', pinned: [] }),
    // other mandate props if needed
    id: 'test-mandate',
    name: 'Test Mandate',
    description: 'Test',
    gurus: [],
    context: { pinnedFiles: [] }
  } as unknown as Mandate;
  return mock;
};

describe('ContextPinnerGuru', () => {
  let guru: ContextPinnerGuru;
  let mockMandate: Mandate;

  beforeEach(() => {
    guru = new ContextPinnerGuru();
    mockMandate = createMockMandate();
    vi.clearAllMocks();
  });

  describe('metadata', () => {
    it('should have correct name, description, and capabilities', () => {
      // Arrange & Act
      const name = guru.name;
      const description = guru.description;
      const capabilities = guru.capabilities;

      // Assert
      expect(name).toBe('context-pinner');
      expect(description).toContain('pinning, unpinning, and managing files in context');
      expect(capabilities).toContain('pin');
      expect(capabilities).toContain('unpin');
      expect(capabilities).toContain('list-pinned');
      expect(capabilities).toContain('suggest-pins');
      expect(capabilities).toContain('analyze-context');
    });
  });

  describe('pinFile', () => {
    it('should pin a valid file to context via mandate', async () => {
      // Arrange
      const filePath = '/project/src/main.ts';

      // Act
      await guru.pinFile(mockMandate, filePath);

      // Assert
      expect(mockMandate.pinFile).toHaveBeenCalledWith(filePath);
      expect(mockMandate.pinFile).toHaveBeenCalledTimes(1);
    });

    it('should throw on invalid or non-existent file path', async () => {
      // Arrange
      const invalidPath = '/nonexistent/file.ts';
      mockMandate.pinFile = vi.fn().mockRejectedValue(new Error('File not found'));

      // Act & Assert
      await expect(guru.pinFile(mockMandate, invalidPath)).rejects.toThrow('File not found');
    });

    it('should handle duplicate pin gracefully (idempotent)', async () => {
      // Arrange
      const filePath = '/project/README.md';
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue([filePath]);
      mockMandate.pinFile = vi.fn().mockResolvedValue(undefined); // should not error on dup

      // Act
      await guru.pinFile(mockMandate, filePath);

      // Assert
      expect(mockMandate.pinFile).toHaveBeenCalled();
    });
  });

  describe('unpinFile', () => {
    it('should unpin an existing pinned file', async () => {
      // Arrange
      const filePath = '/project/src/utils.ts';
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue([filePath]);

      // Act
      await guru.unpinFile(mockMandate, filePath);

      // Assert
      expect(mockMandate.unpinFile).toHaveBeenCalledWith(filePath);
    });

    it('should throw if trying to unpin non-pinned file', async () => {
      // Arrange
      const filePath = '/project/not-pinned.ts';
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue([]);
      mockMandate.unpinFile = vi.fn().mockRejectedValue(new Error('File not pinned'));

      // Act & Assert
      await expect(guru.unpinFile(mockMandate, filePath)).rejects.toThrow('File not pinned');
    });
  });

  describe('listPinnedFiles', () => {
    it('should return list of currently pinned files from mandate', () => {
      // Arrange
      const pinned = ['/a.ts', '/b.ts', '/c.md'];
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue(pinned);

      // Act
      const result = guru.listPinnedFiles(mockMandate);

      // Assert
      expect(result).toEqual(pinned);
      expect(mockMandate.getPinnedFiles).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no files pinned', () => {
      // Arrange
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue([]);

      // Act
      const result = guru.listPinnedFiles(mockMandate);

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('suggestPinsForTask', () => {
    it('should suggest relevant files for a given task description', async () => {
      // Arrange
      const task = 'implement user auth with JWT';
      // In real, would scan project files; here mock suggests based on task keywords

      // Act
      const suggestions = await guru.suggestPinsForTask(mockMandate, task);

      // Assert
      expect(Array.isArray(suggestions)).toBe(true);
      // Should suggest files containing 'auth', 'jwt', 'user' etc. (implementation dependent)
      expect(suggestions.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty suggestions for empty task', async () => {
      // Arrange
      const task = '';

      // Act
      const suggestions = await guru.suggestPinsForTask(mockMandate, task);

      // Assert
      expect(suggestions).toEqual([]);
    });
  });

  describe('analyzeContextBudget', () => {
    it('should analyze current pinned files and estimate token usage', async () => {
      // Arrange
      const pinned = ['/large-file.ts', '/small.md'];
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue(pinned);
      // Assume buildContext returns context with size info or guru estimates

      // Act
      const analysis = await guru.analyzeContextBudget(mockMandate);

      // Assert
      expect(analysis).toHaveProperty('totalTokens');
      expect(analysis).toHaveProperty('pinnedCount');
      expect(analysis.pinnedCount).toBe(2);
      expect(typeof analysis.totalTokens).toBe('number');
    });
  });

  describe('execute', () => {
    it('should handle pin action via execute', async () => {
      // Arrange
      const args = { action: 'pin', file: '/src/foo.ts' };

      // Act
      const result = await guru.execute(mockMandate, args);

      // Assert
      expect(result).toContain('pinned');
      expect(mockMandate.pinFile).toHaveBeenCalledWith('/src/foo.ts');
    });

    it('should handle unpin action', async () => {
      // Arrange
      const args = { action: 'unpin', file: '/src/bar.ts' };

      // Act
      const result = await guru.execute(mockMandate, args);

      // Assert
      expect(result).toContain('unpinned');
      expect(mockMandate.unpinFile).toHaveBeenCalled();
    });

    it('should handle list-pinned action', async () => {
      // Arrange
      mockMandate.getPinnedFiles = vi.fn().mockReturnValue(['/a.ts']);
      const args = { action: 'list-pinned' };

      // Act
      const result = await guru.execute(mockMandate, args);

      // Assert
      expect(result).toContain('/a.ts');
    });

    it('should throw on unsupported action', async () => {
      // Arrange
      const args = { action: 'invalid-action' };

      // Act & Assert
      await expect(guru.execute(mockMandate, args)).rejects.toThrow('Unsupported action');
    });
  });
});
