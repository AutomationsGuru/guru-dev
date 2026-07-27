/**
 * Worktree Lifecycle Manager for Self-Build Developer Loop
 *
 * Manages git worktree creation, tracking, and cleanup for isolated
 * subagent execution. Enables parallel builds without workspace conflicts.
 *
 * DOX: See planning/SELF-BUILD-DEVELOPER-LOOP.md
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  createdAt: Date;
}

export interface WorktreeOptions {
  baseRef?: string;
  discardChanges?: boolean;
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export class WorktreeManager {
  private activeWorktrees: Map<string, WorktreeInfo> = new Map();
  private worktreeBaseDir: string;

  constructor(baseDir?: string) {
    // Default to a .worktrees directory in the project root or use provided path
    this.worktreeBaseDir = baseDir || resolve(process.cwd(), '.worktrees');
    this.ensureBaseDirectory();
  }

  private ensureBaseDirectory(): void {
    if (!existsSync(this.worktreeBaseDir)) {
      mkdirSync(this.worktreeBaseDir, { recursive: true });
    }
  }

  /**
   * Create a new isolated git worktree for subagent execution
   */
  async createWorktree(
    name: string,
    options: WorktreeOptions = {}
  ): Promise<WorktreeInfo> {
    const sanitizedName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
    const timestamp = Date.now();
    const branchName = `selfbuild/${sanitizedName}-${timestamp}`;
    const worktreePath = join(this.worktreeBaseDir, `${sanitizedName}-${timestamp}`);

    // Determine base ref (default to current HEAD)
    const baseRef = options.baseRef || this.getCurrentRef();

    try {
      // Create the worktree
      const createCmd = `git worktree add -b "${branchName}" "${worktreePath}" "${baseRef}"`;
      execSync(createCmd, {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf-8'
      });

      const worktreeInfo: WorktreeInfo = {
        path: resolve(worktreePath),
        branch: branchName,
        baseRef,
        createdAt: new Date()
      };

      this.activeWorktrees.set(worktreeInfo.path, worktreeInfo);

      return worktreeInfo;
    } catch (error) {
      throw new WorktreeError(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
        'CREATE_FAILED',
        { name, baseRef, error }
      );
    }
  }

  /**
   * Remove a worktree and clean up resources
   */
  async removeWorktree(
    worktreePath: string,
    options: WorktreeOptions = {}
  ): Promise<void> {
    const resolvedPath = resolve(worktreePath);
    const worktreeInfo = this.activeWorktrees.get(resolvedPath);

    if (!worktreeInfo && !existsSync(resolvedPath)) {
      // Worktree doesn't exist, nothing to do
      return;
    }

    try {
      // If we have uncommitted changes and discardChanges is true, reset first
      if (options.discardChanges && existsSync(resolvedPath)) {
        try {
          execSync('git reset --hard && git clean -fd', {
            cwd: resolvedPath,
            stdio: 'pipe'
          });
        } catch {
          // Ignore reset errors - we'll still try to remove
        }
      }

      // Remove the worktree
      const removeCmd = `git worktree remove "${resolvedPath}" --force`;
      execSync(removeCmd, {
        cwd: process.cwd(),
        stdio: 'pipe'
      });

      // Clean up the directory if it still exists
      if (existsSync(resolvedPath)) {
        rmSync(resolvedPath, { recursive: true, force: true });
      }

      // Remove branch if we created it
      if (worktreeInfo) {
        try {
          execSync(`git branch -D "${worktreeInfo.branch}"`, {
            cwd: process.cwd(),
            stdio: 'pipe'
          });
        } catch {
          // Branch might have been deleted already or never created
        }
      }

      this.activeWorktrees.delete(resolvedPath);
    } catch (error) {
      throw new WorktreeError(
        `Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`,
        'REMOVE_FAILED',
        { worktreePath: resolvedPath, error }
      );
    }
  }

  /**
   * List all currently active worktrees managed by this instance
   */
  async listActiveWorktrees(): Promise<WorktreeInfo[]> {
    return Array.from(this.activeWorktrees.values());
  }

  /**
   * Clean up all managed worktrees
   */
  async cleanupAll(options: WorktreeOptions = {}): Promise<number> {
    const worktrees = Array.from(this.activeWorktrees.keys());
    let cleanedCount = 0;

    for (const worktreePath of worktrees) {
      try {
        await this.removeWorktree(worktreePath, options);
        cleanedCount++;
      } catch (error) {
        // Log error but continue cleanup
        console.error(`Failed to cleanup worktree ${worktreePath}:`, error);
      }
    }

    return cleanedCount;
  }

  /**
   * Get the current git ref (branch or commit)
   */
  private getCurrentRef(): string {
    try {
      const ref = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();

      // If we're in detached HEAD state, use the commit hash
      if (ref === 'HEAD') {
        return execSync('git rev-parse HEAD', {
          cwd: process.cwd(),
          encoding: 'utf-8',
          stdio: 'pipe'
        }).trim();
      }

      return ref;
    } catch {
      // Fallback to HEAD
      return 'HEAD';
    }
  }

  /**
   * Check if a path is a valid worktree
   */
  static isValidWorktree(path: string): boolean {
    return existsSync(join(path, '.git'));
  }
}

// Export singleton instance for convenience
export const defaultWorktreeManager = new WorktreeManager();
