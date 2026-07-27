/**
 * Output Integrator for Self-Build Developer Loop
 *
 * Merges outputs from isolated worktrees back into the main worktree.
 * Handles file conflicts, selective integration, and change tracking.
 *
 * DOX: See planning/SELF-BUILD-DEVELOPER-LOOP.md
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';

export interface IntegrationResult {
  success: boolean;
  filesIntegrated: number;
  filesSkipped: number;
  conflicts: ConflictInfo[];
  summary: string;
  duration: number;
}

export interface WorktreeSource {
  path: string;
  priority?: number;
  filePatterns?: string[];
  excludePatterns?: string[];
}

export interface ConflictInfo {
  file: string;
  sourcePath: string;
  targetPath: string;
  type: 'content' | 'deletion' | 'addition';
  details?: string;
}

export type ResolutionStrategy = 'ours' | 'theirs' | 'manual' | 'skip';

export interface IntegrationOptions {
  targetPath?: string;
  autoResolve?: boolean;
  resolutionStrategy?: ResolutionStrategy;
  dryRun?: boolean;
  verbose?: boolean;
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export class OutputIntegrator {
  private targetPath: string;

  constructor(targetPath?: string) {
    this.targetPath = targetPath || process.cwd();
  }

  /**
   * Integrate changes from a single worktree into the target
   */
  async integrateFromWorktree(
    sourceWorktree: string,
    options: IntegrationOptions = {}
  ): Promise<IntegrationResult> {
    const startTime = Date.now();
    const resolvedSource = resolve(sourceWorktree);
    const targetDir = options.targetPath || this.targetPath;

    if (!existsSync(resolvedSource)) {
      throw new IntegrationError(
        `Source worktree does not exist: ${resolvedSource}`,
        'SOURCE_NOT_FOUND'
      );
    }

    const result: IntegrationResult = {
      success: true,
      filesIntegrated: 0,
      filesSkipped: 0,
      conflicts: [],
      summary: '',
      duration: 0
    };

    try {
      // Get list of changed files
      const changedFiles = this.getChangedFiles(resolvedSource);

      for (const file of changedFiles) {
        const sourceFile = join(resolvedSource, file);
        const targetFile = join(targetDir, file);

        // Check for conflicts
        const conflict = this.detectFileConflict(sourceFile, targetFile);
        if (conflict) {
          result.conflicts.push(conflict);

          if (options.autoResolve) {
            await this.resolveConflict(conflict, options.resolutionStrategy || 'theirs');
            result.filesIntegrated++;
          } else {
            result.filesSkipped++;
          }
          continue;
        }

        // Copy the file if not a dry run
        if (!options.dryRun) {
          this.copyFileWithDirs(sourceFile, targetFile);
        }
        result.filesIntegrated++;
      }

      result.duration = Date.now() - startTime;
      result.summary = `Integrated ${result.filesIntegrated} files, skipped ${result.filesSkipped}, ${result.conflicts.length} conflicts`;

      return result;
    } catch (error) {
      result.success = false;
      result.summary = `Integration failed: ${error instanceof Error ? error.message : String(error)}`;
      result.duration = Date.now() - startTime;
      return result;
    }
  }

  /**
   * Integrate from multiple worktrees with priority ordering
   */
  async integrateMultiple(
    sources: WorktreeSource[],
    options: IntegrationOptions = {}
  ): Promise<IntegrationResult> {
    const startTime = Date.now();
    const combinedResult: IntegrationResult = {
      success: true,
      filesIntegrated: 0,
      filesSkipped: 0,
      conflicts: [],
      summary: '',
      duration: 0
    };

    // Sort sources by priority (higher priority first)
    const sortedSources = [...sources].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const source of sortedSources) {
      const sourceResult = await this.integrateFromWorktree(source.path, {
        ...options,
        filePatterns: source.filePatterns,
        // Merge exclude patterns
      });

      combinedResult.filesIntegrated += sourceResult.filesIntegrated;
      combinedResult.filesSkipped += sourceResult.filesSkipped;
      combinedResult.conflicts.push(...sourceResult.conflicts);

      if (!sourceResult.success) {
        combinedResult.success = false;
      }
    }

    combinedResult.duration = Date.now() - startTime;
    combinedResult.summary = `Multi-source integration: ${combinedResult.filesIntegrated} files integrated`;

    return combinedResult;
  }

  /**
   * Detect conflicts between source and target files
   */
  detectFileConflict(sourceFile: string, targetFile: string): ConflictInfo | null {
    if (!existsSync(sourceFile)) {
      return null;
    }

    if (!existsSync(targetFile)) {
      // New file - no conflict
      return null;
    }

    // Both exist - check if content differs
    try {
      const sourceContent = execSync(`git hash-object "${sourceFile}"`, {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();

      const targetContent = execSync(`git hash-object "${targetFile}"`, {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();

      if (sourceContent !== targetContent) {
        return {
          file: relative(process.cwd(), targetFile),
          sourcePath: sourceFile,
          targetPath: targetFile,
          type: 'content',
          details: 'File content differs between source and target'
        };
      }
    } catch {
      // If git hash-object fails, compare file sizes as fallback
      const sourceStat = statSync(sourceFile);
      const targetStat = statSync(targetFile);

      if (sourceStat.size !== targetStat.size) {
        return {
          file: relative(process.cwd(), targetFile),
          sourcePath: sourceFile,
          targetPath: targetFile,
          type: 'content',
          details: 'File size differs (content comparison unavailable)'
        };
      }
    }

    return null;
  }

  /**
   * Resolve a file conflict using the specified strategy
   */
  async resolveConflict(
    conflict: ConflictInfo,
    strategy: ResolutionStrategy
  ): Promise<void> {
    switch (strategy) {
      case 'theirs':
        // Use source version (from worktree)
        this.copyFileWithDirs(conflict.sourcePath, conflict.targetPath);
        break;

      case 'ours':
        // Keep target version - do nothing
        break;

      case 'skip':
        // Skip this file - do nothing
        break;

      case 'manual':
        throw new IntegrationError(
          `Manual conflict resolution required for: ${conflict.file}`,
          'MANUAL_RESOLUTION_REQUIRED',
          { conflict }
        );

      default:
        throw new IntegrationError(
          `Unknown resolution strategy: ${strategy}`,
          'INVALID_STRATEGY'
        );
    }
  }

  /**
   * Get list of changed files in a worktree relative to its base
   */
  private getChangedFiles(worktreePath: string): string[] {
    try {
      // Get files that differ from the index
      const output = execSync('git diff --name-only HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe'
      });

      const stagedOutput = execSync('git diff --cached --name-only', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe'
      });

      const allFiles = new Set([
        ...output.trim().split('\n').filter(Boolean),
        ...stagedOutput.trim().split('\n').filter(Boolean)
      ]);

      // Also include untracked files
      const untrackedOutput = execSync('git ls-files --others --exclude-standard', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe'
      });

      untrackedOutput.trim().split('\n').filter(Boolean).forEach(f => allFiles.add(f));

      return Array.from(allFiles);
    } catch {
      // Fallback: return all files in the worktree
      return this.getAllFiles(worktreePath);
    }
  }

  /**
   * Get all files in a directory recursively
   */
  private getAllFiles(dir: string, basePath: string = dir): string[] {
    const files: string[] = [];

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        if (entry === '.git' || entry === 'node_modules') continue;

        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          files.push(...this.getAllFiles(fullPath, basePath));
        } else {
          files.push(relative(basePath, fullPath));
        }
      }
    } catch {
      // Directory might not exist or be inaccessible
    }

    return files;
  }

  /**
   * Copy a file, creating parent directories as needed
   */
  private copyFileWithDirs(source: string, target: string): void {
    const targetDir = dirname(target);

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    copyFileSync(source, target);
  }
}

// Export singleton for convenience
export const defaultIntegrator = new OutputIntegrator();
