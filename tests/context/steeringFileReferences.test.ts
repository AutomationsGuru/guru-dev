import { describe, it, expect, vi } from 'vitest';
import { expand } from '../../src/context/steeringFileReferences.js';

describe('expand', () => {
  const root = '/workspace';

  it('should expand a single file reference with its content', async () => {
    const text = 'Here is the file content: #[[file:example.txt]]';
    const readFile = vi.fn().mockResolvedValue('Hello, world!');
    const result = await expand(text, readFile, root);
    expect(result).toBe('Here is the file content: Hello, world!');
    expect(readFile).toHaveBeenCalledWith('/workspace/example.txt');
  });

  it('should expand multiple file references', async () => {
    const text = 'File 1: #[[file:one.txt]], File 2: #[[file:two.md]]';
    const readFile = vi.fn()
      .mockResolvedValueOnce('Content of one.')
      .mockResolvedValueOnce('Content of two.');
    const result = await expand(text, readFile, root);
    expect(result).toBe('File 1: Content of one., File 2: Content of two.');
    expect(readFile).toHaveBeenCalledWith('/workspace/one.txt');
    expect(readFile).toHaveBeenCalledWith('/workspace/two.md');
  });

  it('should return a note for a missing file', async () => {
    const text = 'Include the missing file: #[[file:nonexistent.txt]]';
    const readFile = vi.fn().mockResolvedValue(null);
    const result = await expand(text, readFile, root);
    expect(result).toBe('Include the missing file: [[File not found: nonexistent.txt]]');
    expect(readFile).toHaveBeenCalledWith('/workspace/nonexistent.txt');
  });

  it('should reject paths attempting to escape the root directory', async () => {
    const text = 'Trying to escape: #[[file:../secret.txt]]';
    const readFile = vi.fn();
    const result = await expand(text, readFile, root);
    expect(result).toBe('Trying to escape: [[Invalid path: ../secret.txt]]');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('should reject absolute paths', async () => {
    const text = 'Trying an absolute path: #[[file:/etc/passwd]]';
    const readFile = vi.fn();
    const result = await expand(text, readFile, root);
    expect(result).toBe('Trying an absolute path: [[Invalid path: /etc/passwd]]');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('should handle nested paths correctly', async () => {
    const text = 'Nested file: #[[file:docs/guide.md]]';
    const readFile = vi.fn().mockResolvedValue('This is the guide.');
    const result = await expand(text, readFile, root);
    expect(result).toBe('Nested file: This is the guide.');
    expect(readFile).toHaveBeenCalledWith('/workspace/docs/guide.md');
  });

  it('should return original text if no file references are present', async () => {
    const text = 'This is just a regular string with no file references.';
    const readFile = vi.fn();
    const result = await expand(text, readFile, root);
    expect(result).toBe(text);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('should handle empty file content', async () => {
    const text = 'An empty file: #[[file:empty.txt]]';
    const readFile = vi.fn().mockResolvedValue('');
    const result = await expand(text, readFile, root);
    expect(result).toBe('An empty file: ');
    expect(readFile).toHaveBeenCalledWith('/workspace/empty.txt');
  });

  it('should handle mixture of valid, invalid, and missing files', async () => {
    const text = 'Valid: #[[file:a.txt]], Invalid: #[[file:../b.txt]], Missing: #[[file:c.txt]]';
    const readFile = vi.fn()
        .mockImplementation(async (path: string) => {
            if (path === '/workspace/a.txt') return 'Content A';
            if (path === '/workspace/c.txt') return null;
            return null;
        });

    const result = await expand(text, readFile, root);
    expect(result).toBe('Valid: Content A, Invalid: [[Invalid path: ../b.txt]], Missing: [[File not found: c.txt]]');
    expect(readFile).toHaveBeenCalledWith('/workspace/a.txt');
    expect(readFile).toHaveBeenCalledWith('/workspace/c.txt');
    expect(readFile).not.toHaveBeenCalledWith('/workspace/../b.txt');
  });
});
