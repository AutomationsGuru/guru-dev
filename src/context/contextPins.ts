import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * ContextPins — simple per-session file pinning for GuruHarness.
 * Pins are included in context until explicitly unpinned.
 * Used by ContextPinnerGuru and CLI pin command.
 */
export class ContextPins {
  private pinnedFiles: Set<string> = new Set();

  /**
   * Pin a file into context. Idempotent — duplicate pins are no-ops.
   * Throws if file does not exist on disk.
   */
  async pinFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    try {
      await fs.access(absolutePath);
    } catch {
      throw new Error(`File not found: ${absolutePath}`);
    }
    this.pinnedFiles.add(absolutePath);
  }

  /**
   * Unpin a previously pinned file. No-op if not pinned.
   */
  async unpinFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    this.pinnedFiles.delete(absolutePath);
  }

  /**
   * Return currently pinned files in insertion order.
   */
  getPinnedFiles(): string[] {
    return Array.from(this.pinnedFiles);
  }

  /**
   * Check if a file is currently pinned.
   */
  isPinned(filePath: string): boolean {
    return this.pinnedFiles.has(path.resolve(filePath));
  }

  /**
   * Clear all pins (session reset).
   */
  clearAll(): void {
    this.pinnedFiles.clear();
  }

  /**
   * Build context payload including pinned file contents.
   * In real usage this would be merged into Mandate/Harness context.
   */
  async buildContextWithPins(baseContext: string = ''): Promise<string> {
    const pinned = this.getPinnedFiles();
    if (pinned.length === 0) return baseContext;

    let context = baseContext ? baseContext + '\n\n' : '';
    context += '## Pinned Context Files\n';

    for (const file of pinned) {
      try {
        const content = await fs.readFile(file, 'utf8');
        context += `\n### ${file}\n\`\`\`\n${content}\n\`\`\`\n`;
      } catch {
        // Skip unreadable files silently (or could log)
      }
    }
    return context.trim();
  }
}

// Default singleton for simple use
export const contextPins = new ContextPins();
