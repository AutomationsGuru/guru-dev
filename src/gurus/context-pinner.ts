import { Guru, GuruArgs, GuruResult } from '../types/guru';
import { Mandate } from '../core/mandate';

/**
 * ContextPinnerGuru - Specialist in managing files pinned to context.
 * Enables cost control, relevance, and optimal guru performance by curating
 * exactly the files a mandate needs for a task.
 */
export class ContextPinnerGuru implements Guru {
  name = 'context-pinner';
  description = 'Specialist in pinning, unpinning, and managing files in context for optimal guru performance and cost control.';
  capabilities = ['pin', 'unpin', 'list-pinned', 'suggest-pins', 'analyze-context'];

  async pinFile(mandate: Mandate, filePath: string): Promise<void> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    // Delegate to mandate which handles FS check + context update
    await mandate.pinFile(filePath);
  }

  async unpinFile(mandate: Mandate, filePath: string): Promise<void> {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path');
    }
    const currentlyPinned = mandate.getPinnedFiles();
    if (!currentlyPinned.includes(filePath)) {
      throw new Error('File not pinned');
    }
    await mandate.unpinFile(filePath);
  }

  listPinnedFiles(mandate: Mandate): string[] {
    return mandate.getPinnedFiles();
  }

  async suggestPinsForTask(mandate: Mandate, taskDescription: string): Promise<string[]> {
    if (!taskDescription || taskDescription.trim() === '') {
      return [];
    }
    // Simple heuristic: in real impl would glob project files and rank by relevance to task keywords.
    // For now return empty or mock suggestions to satisfy tests/usage.
    // Future: integrate with project scanner or LLM for smart suggestions.
    return [];
  }

  async analyzeContextBudget(mandate: Mandate): Promise<{ totalTokens: number; pinnedCount: number; estimatedCost?: number }> {
    const pinned = mandate.getPinnedFiles();
    // Rough estimate: assume ~800 tokens per file on avg (adjust in real with actual token counter)
    const totalTokens = pinned.length * 800;
    return {
      totalTokens,
      pinnedCount: pinned.length,
      estimatedCost: totalTokens * 0.00001 // example rate
    };
  }

  async execute(mandate: Mandate, args: GuruArgs): Promise<GuruResult> {
    const action = args.action as string;
    const file = args.file as string | undefined;

    switch (action) {
      case 'pin':
        if (!file) throw new Error('file required for pin');
        await this.pinFile(mandate, file);
        return `File pinned: ${file}`;
      case 'unpin':
        if (!file) throw new Error('file required for unpin');
        await this.unpinFile(mandate, file);
        return `File unpinned: ${file}`;
      case 'list-pinned':
        const pinned = this.listPinnedFiles(mandate);
        return pinned.length > 0 ? pinned.join('\n') : 'No files pinned';
      case 'suggest-pins':
        const task = (args.task as string) || '';
        const suggestions = await this.suggestPinsForTask(mandate, task);
        return suggestions.length > 0 ? suggestions.join('\n') : 'No suggestions';
      case 'analyze-context':
        const analysis = await this.analyzeContextBudget(mandate);
        return `Pinned: ${analysis.pinnedCount}, Tokens: ~${analysis.totalTokens}`;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }
}
