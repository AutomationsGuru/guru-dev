/**
 * Worktree Lifecycle Manager for GuruHarness Self-Build Developer Loop
 *
 * Handles creation of isolated private git worktrees for subagents,
 * metadata tracking via registry, change detection/diff generation,
 * safe integration back to main with conflict detection,
 * and cleanup supporting both 'keep' (preserve branch) and 'remove' (delete branch) modes.
 *
 * Supports EnterWorktree/ExitWorktree harness pattern.
 * Worktrees are created under .claude/worktrees/ (configurable) relative to project root.
 *
 * DOX: This module owns the worktree lifecycle contract for self-build subagent isolation.
 * All mutations to worktrees must go through this manager.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

/**
 * Metadata for a single private worktree instance.
 */
export interface WorktreeMetadata {
  /** Unique identifier for the worktree (e.g. wt-xxx) */
  id: string;
  /** Absolute filesystem path to the worktree checkout */
  path: string;
  /** Git branch name associated with this worktree (local to repo) */
  branch: string;
  /** SHA of the base commit this worktree was branched from */
  baseCommit: string;
  /** ISO timestamp when worktree was created */
  createdAt: string;
  /** Current lifecycle status */
  status: 'active' | 'integrating' | 'cleaned' | 'error';
  /** Optional subagent identifier that owns/uses this worktree */
  ownerSubagent?: string;
  /** Last known activity timestamp (updated on use) */
  lastActivity?: string;
}

/**
 * Persistent registry tracking all active and recent worktrees for a repo.
 */
export interface WorktreeRegistry {
  /** Map of worktreeId -> metadata */
  worktrees: Record<string, WorktreeMetadata>;
  /** Configured root directory where worktrees are materialized */
  worktreeRoot: string;
  /** Schema version for future migrations */
  version: number;
}

/**
 * Options for creating a new worktree.
 */
export interface CreateWorktreeOptions {
  /** Base ref to branch from (default: HEAD) */
  baseRef?: string;
  /** Prefix for the generated branch name (default: 'agent') */
  branchPrefix?: string;
  /** Subagent that will use this worktree (for ownership tracking) */
  ownerSubagent?: string;
}

/**
 * Result of change detection / diff generation.
 */
export interface ChangeDetectionResult {
  /** List of files that changed relative to baseCommit */
  changedFiles: string[];
  /** Unified diff of committed changes (base..HEAD) */
  diff: string;
  /** Whether there are uncommitted changes in the worktree */
  hasUncommittedChanges: boolean;
  /** Uncommitted diff if hasUncommittedChanges */
  uncommittedDiff?: string;
}

/**
 * Options for integrating changes from a worktree back to main.
 */
export interface IntegrateOptions {
  /** Merge strategy: 'merge' (default, --no-ff), 'squash', 'cherry-pick' */
  strategy?: 'merge' | 'squash' | 'cherry-pick';
  /** If true, attempt to auto-resolve simple conflicts (not recommended for safety) */
  autoResolve?: boolean;
  /** Custom commit message for the integration commit */
  commitMessage?: string;
}

/**
 * Result of an integration attempt.
 */
export interface IntegrateResult {
  success: boolean;
  /** If failed due to conflicts, list of conflicted file paths */
  conflicts?: string[];
  /** The new commit SHA created on main (if success) */
  integratedCommit?: string;
  /** Error message or details */
  error?: string;
}

/**
 * Custom error class for worktree operations.
 */
export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * WorktreeLifecycleManager - Core implementation of the lifecycle.
 *
 * All operations are async and use git CLI via child_process for maximum compatibility
 * with existing repo state. Registry ensures durability across agent restarts.
 */
export class WorktreeLifecycleManager {
  private readonly registryPath: string;
  private readonly worktreeRoot: string;

  constructor(worktreeRoot?: string) {
    // Default to .claude/worktrees under current working dir (project root)
    this.worktreeRoot = worktreeRoot || path.resolve(process.cwd(), '.claude', 'worktrees');
    this.registryPath = path.join(this.worktreeRoot, '.registry.json');
  }

  /**
   * Ensures the worktree root and registry exist.
   */
  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.worktreeRoot, { recursive: true });
    try {
      await fs.access(this.registryPath);
    } catch {
      const initial: WorktreeRegistry = {
        worktrees: {},
        worktreeRoot: this.worktreeRoot,
        version: 1,
      };
      await fs.writeFile(this.registryPath, JSON.stringify(initial, null, 2), 'utf8');
    }
  }

  /**
   * Loads the current registry from disk (creates if missing).
   */
  private async loadRegistry(): Promise<WorktreeRegistry> {
    await this.ensureRoot();
    try {
      const content = await fs.readFile(this.registryPath, 'utf8');
      return JSON.parse(content) as WorktreeRegistry;
    } catch (err) {
      // Corrupt or missing -> reset
      const fresh: WorktreeRegistry = {
        worktrees: {},
        worktreeRoot: this.worktreeRoot,
        version: 1,
      };
      await this.saveRegistry(fresh);
      return fresh;
    }
  }

  /**
   * Atomically saves the registry.
   */
  private async saveRegistry(registry: WorktreeRegistry): Promise<void> {
    const tmp = `${this.registryPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(tmp, this.registryPath);
  }

  /**
   * Generates a unique, filesystem-safe worktree identifier.
   */
  private generateId(): string {
    return `wt-${Date.now().toString(36)}-${randomUUID().split('-')[0]}`;
  }

  /**
   * Runs a git command in the specified directory (or main cwd).
   */
  private async git(command: string, cwd?: string): Promise<string> {
    const fullCmd = cwd ? `git -C "${cwd}" ${command}` : `git ${command}`;
    try {
      const { stdout } = await execAsync(fullCmd, { maxBuffer: 10 * 1024 * 1024 });
      return stdout.trim();
    } catch (err: any) {
      const stderr = err.stderr?.toString() || err.message;
      throw new WorktreeError(
        `Git command failed: ${command}`,
        'GIT_COMMAND_FAILED',
        { command, stderr, cwd }
      );
    }
  }

  /**
   * Creates a new isolated private worktree for a subagent.
   *
   * Uses `git worktree add -b <branch> <path> <baseRef>`
   * Records full metadata in the registry.
   */
  async createWorktree(options: CreateWorktreeOptions = {}): Promise<WorktreeMetadata> {
    const id = this.generateId();
    const branchPrefix = options.branchPrefix || 'agent';
    const branch = `${branchPrefix}/${id}`;
    const wtPath = path.join(this.worktreeRoot, id);
    const baseRef = options.baseRef || 'HEAD';

    try {
      // Validate we are in a git repo
      await this.git('rev-parse --is-inside-work-tree');

      const baseCommit = await this.git(`rev-parse ${baseRef}`);

      // Create the worktree + branch
      await this.git(`worktree add -b ${branch} "${wtPath}" ${baseRef}`);

      const metadata: WorktreeMetadata = {
        id,
        path: wtPath,
        branch,
        baseCommit,
        createdAt: new Date().toISOString(),
        status: 'active',
        ownerSubagent: options.ownerSubagent,
        lastActivity: new Date().toISOString(),
      };

      const registry = await this.loadRegistry();
      registry.worktrees[id] = metadata;
      await this.saveRegistry(registry);

      return metadata;
    } catch (err: any) {
      // Attempt partial cleanup on failure
      try {
        await fs.rm(wtPath, { recursive: true, force: true });
        await this.git(`branch -D ${branch}`).catch(() => {});
      } catch {
        // ignore cleanup errors
      }
      if (err instanceof WorktreeError) throw err;
      throw new WorktreeError(
        `Failed to create worktree ${id}`,
        'CREATE_FAILED',
        { originalError: err.message, options }
      );
    }
  }

  /**
   * Retrieves metadata for a specific worktree.
   */
  async getWorktree(worktreeId: string): Promise<WorktreeMetadata | null> {
    const registry = await this.loadRegistry();
    return registry.worktrees[worktreeId] || null;
  }

  /**
   * Lists all currently tracked (active) worktrees.
   */
  async listWorktrees(): Promise<WorktreeMetadata[]> {
    const registry = await this.loadRegistry();
    return Object.values(registry.worktrees).filter(wt => wt.status !== 'cleaned');
  }

  /**
   * Detects changes and generates diff for a worktree.
   *
   * Compares against the recorded baseCommit.
   * Includes both committed and uncommitted changes.
   */
  async detectChanges(worktreeId: string): Promise<ChangeDetectionResult> {
    const meta = await this.getWorktree(worktreeId);
    if (!meta) {
      throw new WorktreeError(`Worktree ${worktreeId} not found`, 'NOT_FOUND');
    }

    try {
      const cwd = meta.path;

      // Check for uncommitted changes
      const statusPorcelain = await this.git('status --porcelain', cwd);
      const hasUncommittedChanges = statusPorcelain.length > 0;

      let uncommittedDiff: string | undefined;
      if (hasUncommittedChanges) {
        uncommittedDiff = await this.git('diff --no-color', cwd);
      }

      // Committed changes since base
      const diff = await this.git(`diff --no-color ${meta.baseCommit}..HEAD`, cwd);
      const changedFilesRaw = await this.git(`diff --name-only ${meta.baseCommit}..HEAD`, cwd);
      const changedFiles = changedFilesRaw ? changedFilesRaw.split('\n').filter(Boolean) : [];

      // Update lastActivity
      meta.lastActivity = new Date().toISOString();
      const registry = await this.loadRegistry();
      registry.worktrees[worktreeId] = meta;
      await this.saveRegistry(registry);

      return {
        changedFiles,
        diff,
        hasUncommittedChanges,
        uncommittedDiff,
      };
    } catch (err: any) {
      throw new WorktreeError(
        `Failed to detect changes for ${worktreeId}`,
        'DETECT_FAILED',
        { originalError: err.message }
      );
    }
  }

  /**
   * Safely integrates changes from the private worktree back into the main branch.
   *
   * Uses git merge-tree for pre-flight conflict detection.
   * Supports merge, squash, cherry-pick strategies.
   * Never auto-commits on conflict; always reports conflicts.
   */
  async integrateChanges(
    worktreeId: string,
    options: IntegrateOptions = {}
  ): Promise<IntegrateResult> {
    const meta = await this.getWorktree(worktreeId);
    if (!meta) {
      throw new WorktreeError(`Worktree ${worktreeId} not found`, 'NOT_FOUND');
    }

    const strategy = options.strategy || 'merge';
    const commitMessage =
      options.commitMessage || `feat(selfbuild): integrate worktree ${worktreeId} from ${meta.ownerSubagent || 'subagent'}`;

    // Mark as integrating
    meta.status = 'integrating';
    let registry = await this.loadRegistry();
    registry.worktrees[worktreeId] = meta;
    await this.saveRegistry(registry);

    try {
      const mainCwd = process.cwd(); // assume caller is on main

      // Pre-flight conflict detection using merge-tree (works even if unmerged)
      const mergeBase = await this.git(`merge-base HEAD ${meta.branch}`);
      const mergeTreeOutput = await this.git(`merge-tree ${mergeBase} HEAD ${meta.branch}`);

      if (mergeTreeOutput.includes('<<<<<<<')) {
        // Parse conflicted files from merge-tree output
        const conflicts = this.parseConflictedFiles(mergeTreeOutput);
        meta.status = 'error';
        registry = await this.loadRegistry();
        registry.worktrees[worktreeId] = meta;
        await this.saveRegistry(registry);

        return {
          success: false,
          conflicts,
          error: 'Merge conflicts detected',
        };
      }

      // No conflicts - perform the integration
      let integratedCommit: string;

      switch (strategy) {
        case 'squash':
          await this.git(`merge --squash ${meta.branch}`);
          await this.git(`commit -m "${commitMessage}"`);
          integratedCommit = await this.git('rev-parse HEAD');
          break;

        case 'cherry-pick':
          await this.git(`cherry-pick ${meta.branch}`);
          integratedCommit = await this.git('rev-parse HEAD');
          break;

        case 'merge':
        default:
          await this.git(`merge --no-ff -m "${commitMessage}" ${meta.branch}`);
          integratedCommit = await this.git('rev-parse HEAD');
          break;
      }

      // Success - mark cleaned
      meta.status = 'cleaned';
      registry = await this.loadRegistry();
      registry.worktrees[worktreeId] = meta;
      await this.saveRegistry(registry);

      return {
        success: true,
        integratedCommit,
      };
    } catch (err: any) {
      // Attempt to abort any in-progress merge
      try {
        await this.git('merge --abort');
      } catch {
        // ignore
      }

      meta.status = 'error';
      registry = await this.loadRegistry();
      registry.worktrees[worktreeId] = meta;
      await this.saveRegistry(registry);

      return {
        success: false,
        error: err.message || 'Integration failed',
      };
    }
  }

  /**
   * Parses conflicted file paths from git merge-tree output.
   */
  private parseConflictedFiles(mergeTreeOutput: string): string[] {
    const conflicts: string[] = [];
    const lines = mergeTreeOutput.split('\n');
    for (const line of lines) {
      if (line.includes('<<<<<<<')) {
        // merge-tree format often has "path" before the marker
        const match = line.match(/^\s*(\S+.*)\s*$/);
        if (match) conflicts.push(match[1].trim());
      }
    }
    return [...new Set(conflicts)]; // dedupe
  }

  /**
   * Cleans up a worktree.
   *
   * 'remove' mode: removes worktree + deletes the branch (destructive)
   * 'keep' mode: removes only the worktree checkout, branch remains for later inspection/merge
   */
  async cleanupWorktree(worktreeId: string, mode: 'keep' | 'remove' = 'remove'): Promise<void> {
    const meta = await this.getWorktree(worktreeId);
    if (!meta) {
      return; // idempotent
    }

    try {
      if (mode === 'remove') {
        // Force remove worktree and delete branch
        await this.git(`worktree remove --force "${meta.path}"`);
        await this.git(`branch -D ${meta.branch}`).catch(() => {
          // Branch may already be gone or not fully merged; safe to ignore
        });
      } else {
        // keep: only prune the worktree checkout, leave branch intact
        await this.git(`worktree remove "${meta.path}"`);
      }

      // Remove from registry or mark cleaned
      const registry = await this.loadRegistry();
      if (mode === 'remove') {
        delete registry.worktrees[worktreeId];
      } else {
        meta.status = 'cleaned';
        registry.worktrees[worktreeId] = meta;
      }
      await this.saveRegistry(registry);

      // Final filesystem safety net (in case git left artifacts)
      try {
        await fs.rm(meta.path, { recursive: true, force: true });
      } catch {
        // already removed by git worktree remove
      }
    } catch (err: any) {
      throw new WorktreeError(
        `Failed to cleanup worktree ${worktreeId} in ${mode} mode`,
        'CLEANUP_FAILED',
        { originalError: err.message, mode }
      );
    }
  }

  /**
   * Validates that a path is a valid worktree managed by this instance.
   */
  async isValidWorktreePath(targetPath: string): Promise<boolean> {
    const registry = await this.loadRegistry();
    return Object.values(registry.worktrees).some((wt) => wt.path === path.resolve(targetPath));
  }
}

// Default export for convenience
export default WorktreeLifecycleManager;
