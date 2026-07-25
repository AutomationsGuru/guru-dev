/**
 * Builtin git-diff context provider.
 *
 * Surfaces the unstaged + staged diff for a repo as a single snippet, sliced to
 * the character budget. Git is invoked through an injectable {@link CommandExecutor}
 * (the same seam used by `src/git/prAutomation.ts`), so the provider is fully
 * testable and degrades to "no snippets" — never an exception — when git is
 * missing, the cwd is not a repo, or the diff is empty.
 *
 * This is a native BUILD: no git SDK, no dependency, no edit to core. The
 * underlying `git` CLI is treated as a present-or-absent capability; when absent
 * the provider reports nothing rather than failing the turn.
 */
import { executeCommand, type CommandExecutor } from "../../review/gates.js";

import type { ContextBudget, ContextProvider, ContextSnippet } from "./types.js";

export interface GitDiffProviderOptions {
  /** Repository root to diff. */
  readonly repoRoot: string;
  /**
   * Command executor used to run git. Defaults to the shared
   * {@link executeCommand}; tests inject a fake.
   */
  readonly executor?: CommandExecutor;
}

/** A git-diff result provider nodes can introspect without re-running git. */
export interface GitDiffProviderSnapshot {
  readonly gitAvailable: boolean;
  readonly diff: string;
}

const DEFAULT_DIFF_LABEL = "Git diff (unstaged + staged)";

/**
 * Probe git and capture the unstaged+staged diff as plain text. Returns
 * `{ gitAvailable: false, diff: "" }` for any non-zero git exit (missing
 * binary, not a repo, etc.) so callers never see an exception for ordinary
 * absence.
 */
export async function captureGitDiffSnapshot(
  options: GitDiffProviderOptions
): Promise<GitDiffProviderSnapshot> {
  const executor = options.executor ?? executeCommand;
  // A nullish executor means "no git available in this environment" — the stub path.
  if (!executor) {
    return { gitAvailable: false, diff: "" };
  }

  const result = await executor(
    ["git", "-C", options.repoRoot, "diff", "HEAD", "--no-color"],
    {
      cwd: options.repoRoot,
      gate: {
        kind: "validation",
        name: "git-diff-context",
        command: ["git", "-C", options.repoRoot, "diff", "HEAD", "--no-color"],
        required: false
      }
    }
  );

  if (result.exitCode !== 0) {
    return { gitAvailable: false, diff: "" };
  }

  return { gitAvailable: true, diff: result.stdout };
}

/**
 * Truncate a diff body to a character budget, preserving the leading portion
 * (the most recent / highest-priority changes) and appending a truncation
 * marker so the model knows context was elided. When the body already fits it
 * is returned unchanged.
 */
export function sliceDiffToBudget(body: string, budget: ContextBudget): string {
  if (body.length <= budget.maxChars) {
    return body;
  }
  // Reserve room for the ellipsis marker so the final string respects the cap.
  const marker = "\n…<diff truncated to fit context budget>";
  if (budget.maxChars <= marker.length) {
    // Budget too small to fit a meaningful slice plus the marker: return only
    // what fits, never exceeding the cap.
    return body.slice(0, budget.maxChars);
  }
  const keep = budget.maxChars - marker.length;
  return `${body.slice(0, keep)}${marker}`;
}

/** Create a git-diff {@link ContextProvider}. */
export function createGitDiffProvider(options: GitDiffProviderOptions): ContextProvider {
  const repoRoot = options.repoRoot;

  return {
    id: "git-diff",
    label: "Git diff",
    async collect(budget): Promise<readonly ContextSnippet[]> {
      if (budget.maxChars <= 0) {
        return [];
      }
      const snapshot = await captureGitDiffSnapshot(options);
      if (!snapshot.gitAvailable || snapshot.diff.trim().length === 0) {
        return [];
      }
      const body = sliceDiffToBudget(snapshot.diff, budget);
      const snippet: ContextSnippet = {
        id: "git-diff:head",
        label: DEFAULT_DIFF_LABEL,
        body,
        priority: 0
      };
      return [snippet];
    }
  };
}
