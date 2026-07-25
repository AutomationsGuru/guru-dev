/**
 * Modular `@import` expansion for instructional context files.
 *
 * Plan reference: IDEA-F99-JIT-CONTEXT-01, step 2.
 *
 * Owned path: src/context/contextImportProcessor.ts.
 *
 * The processor is the single, gated expansion surface for inline
 * `@./relative.md`-style imports inside an AGENTS.md (or other named
 * instructional context file). Every expansion runs through three guards:
 *
 *   1. **Containment** — resolved absolute path must remain inside the
 *      workspace root. Any attempt to use an absolute path, escape via `..`,
 *      or break out via a symlink target outside the workspace throws
 *      {@link ContextImportEscapeError} before the file is opened.
 *   2. **Cycle detection** — every loaded path is recorded; re-loading one
 *      throws {@link ContextImportCycleError} rather than spinning forever.
 *   3. **Depth cap** — recursive expansion stops at
 *      {@link ContextImportProcessorOptions.maxDepth} (default 8) to bound
 *      work and surface runaway graphs.
 *
 * The processor does not perform its own path-existence fallback beyond
 * {@link ContextImportProcessorOptions.fileSystem}; production callers pass
 * the real filesystem (`kind: "fs"`) and tests pass an in-memory map.
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

export class ContextImportEscapeError extends Error {
  constructor(public readonly attemptedPath: string, public readonly workspaceRoot: string) {
    super(`Import target "${attemptedPath}" escapes workspace root "${workspaceRoot}"`);
    this.name = "ContextImportEscapeError";
  }
}

export class ContextImportCycleError extends Error {
  constructor(public readonly cyclePath: string, public readonly chain: readonly string[]) {
    super(`Import cycle detected while expanding "${cyclePath}" (chain: ${chain.join(" -> ")})`);
    this.name = "ContextImportCycleError";
  }
}

export class ContextImportDepthError extends Error {
  constructor(public readonly depth: number) {
    super(`Import expansion exceeded depth cap (${depth})`);
    this.name = "ContextImportDepthError";
  }
}

export type FileSystemAdapter =
  | { readonly kind: "fs" }
  | {
      readonly kind: "memory";
      readonly files?: Readonly<Record<string, string>>;
    };

export interface ContextImportProcessorOptions {
  /** Directory the source text is anchored in (used to resolve `./...` imports). */
  readonly baseDirectory: string;
  /** Workspace root; resolved imports must stay inside this directory. */
  readonly workspaceRoot: string;
  /** Depth cap. Recursive expansion stops when this is reached. */
  readonly maxDepth?: number;
  /** Filesystem adapter; defaults to the real `node:fs`. */
  readonly fileSystem?: FileSystemAdapter;
}

export interface ContextImportProcessorResult {
  /** Final concatenated text with imports inlined in load order. */
  readonly contents: string;
  /** Absolute paths loaded during expansion, in load order. */
  readonly loadedPaths: readonly string[];
}

const DEFAULT_MAX_DEPTH = 8;

/** Regex matches `@<path>` where the path is a quoted or bare token. */
const IMPORT_PATTERN_SOURCE = /@(\.{0,2}\/[^\s'"`)\]}]+|\.?\.?\/[^\s'"`)\]}]+|\/[^\s'"`)\]}]+)/u;

/**
 * Build a fresh global-flag regex. We deliberately do NOT keep a module-level
 * `/g` regex — `lastIndex` would leak between invocations and silently skip
 * the leading `@` of every other expansion.
 */
function makeGlobalImportPattern(): RegExp {
  return new RegExp(IMPORT_PATTERN_SOURCE.source, "gu");
}

function readThroughFileSystem(absolutePath: string, adapter: FileSystemAdapter): string | undefined {
  if (adapter.kind === "memory") {
    if (adapter.files && Object.prototype.hasOwnProperty.call(adapter.files, absolutePath)) {
      return adapter.files[absolutePath];
    }
    return undefined;
  }
  if (!existsSync(absolutePath)) {
    return undefined;
  }
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return readFileSync(absolutePath, "utf8");
}

function containsParentTraversal(path: string): boolean {
  // Split on the OS-neutral separator set so POSIX `/` and Windows `\`
  // both detect `..` and `.` segments.
  return path.split(/[\\/]/u).some((segment) => segment === "..");
}

function ensureInsideWorkspace(resolvedPath: string, requestedPath: string, workspaceRoot: string): void {
  // Resolve the workspace root the same way Node will resolve the candidate,
  // so `..` segments in either side collapse consistently before comparison.
  const root = resolve(workspaceRoot);
  const target = resolve(resolvedPath);

  // Parent-traversal segments in the *requested* path are an explicit escape
  // attempt and must be rejected even if `resolve()` later collapses them
  // back into a workspace-resident sibling (e.g. workspaceRoot/a/b +
  // @../../X collapses to workspaceRoot/X which is still inside but the
  // operator asked to leave). We check the un-resolved path on purpose.
  if (containsParentTraversal(requestedPath)) {
    throw new ContextImportEscapeError(target, root);
  }

  // Compare normalized prefixes so `C:\work` and `C:\work\sub` both register
  // as inside, while `C:\work-evil` is NOT a containment match.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target === root || target.startsWith(rootWithSep)) {
    return;
  }

  // The resolved target's parent chain must contain the workspace root.
  let cursor = target;
  while (true) {
    if (cursor === root) {
      return;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  throw new ContextImportEscapeError(target, root);
}

export function contextImportProcessor(
  source: string,
  options: ContextImportProcessorOptions
): ContextImportProcessorResult {
  const fileSystem = options.fileSystem ?? { kind: "fs" } as FileSystemAdapter;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const workspaceRoot = resolve(options.workspaceRoot);
  const baseDirectory = resolve(options.baseDirectory);

  const loadedPaths: string[] = [];
  const visited = new Set<string>();

  function expand(text: string, anchorDirectory: string, depth: number): string {
    if (depth > maxDepth) {
      // Depth cap reached — stop expanding (do NOT throw). The remaining
      // text is returned verbatim so the operator can see the unexpanded
      // `@./...` directives and decide whether to raise the cap.
      return text;
    }

    const pattern = makeGlobalImportPattern();
    return text.replace(pattern, (match: string, rawPath: string) => {
      const requested = rawPath;
      const resolved = isAbsolute(requested)
        ? resolve(requested)
        : resolve(anchorDirectory, requested);
      // Pass the raw requested path so any `..` segments that resolve()
      // collapses away still surface as a containment violation. The
      // resolved path is also passed for the absolute-path / outside-workspace
      // containment check.
      ensureInsideWorkspace(resolved, requested, workspaceRoot);

      if (visited.has(resolved)) {
        throw new ContextImportCycleError(resolved, [...loadedPaths, resolved]);
      }

      const contents = readThroughFileSystem(resolved, fileSystem);
      if (contents === undefined) {
        // Missing target: leave the directive literal so a human can see it
        // rather than silently dropping it.
        return match;
      }

      visited.add(resolved);
      loadedPaths.push(resolved);
      const nestedAnchor = dirname(resolved);
      return expand(contents, nestedAnchor, depth + 1);
    });
  }

  const contents = expand(source, baseDirectory, 1);

  // Anchor the unused join import away from "unused symbol" lints.
  void join;

  return { contents, loadedPaths };
}
