/**
 * Hierarchical JIT context resolver.
 *
 * Plan reference: IDEA-F99-JIT-CONTEXT-01.
 *
 * Owned path: src/context/hierarchicalJitContext.ts.
 *
 * Composes three ordered sources, evaluated lazily on each tool access:
 *
 *   1. **Home baseline** — operator-owned `~/.guruharness/AGENTS.md` content
 *      (or whatever names are configured). Always first so operator
 *      instructions outrank project content.
 *   2. **Ancestor chain** — walk from the access path's directory up to the
 *      trusted project root, collecting each directory's instructional
 *      context file in root-to-leaf order. Files outside the access path's
 *      lineage are NOT eagerly scanned (the JIT property).
 *   3. **Import expansion** — every loaded file is passed through
 *      {@link contextImportProcessor} so `@./relative.md` directives inline
 *      additional instructions under the same guards (containment, cycle,
 *      depth).
 *
 * When the workspace is marked `untrusted` (compose F94), project-level
 * files are skipped entirely; only the home baseline contributes. The
 * caller must surface that fact (recorded in `skipped`) so the operator
 * understands the gap is intentional rather than missing.
 *
 * The resolver is registered as an extension/tool seam candidate; it does
 * NOT edit core. Future wiring lives in `src/session/*` and
 * `src/tools/builtins/*` (not in this file).
 */

import { dirname, relative, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  contextImportProcessor,
  type ContextImportProcessorOptions,
  type ContextImportProcessorResult
} from "./contextImportProcessor.js";

export interface HierarchicalJitHomeFile {
  readonly path: string;
  readonly contents: string;
}

export type WorkspaceTrust = "trusted" | "untrusted";

export interface HierarchicalJitOptions {
  /** Optional home baseline content (already read by caller). */
  readonly homeBaselineFiles?: readonly HierarchicalJitHomeFile[];
  /** Configurable file names searched in each directory. Default: ["AGENTS.md"]. */
  readonly fileNames?: readonly string[];
  /** Workspace trust gate; default "trusted". Compose F94. */
  readonly trust?: WorkspaceTrust;
  /** Filesystem adapter forwarded to the import processor. */
  readonly fileSystem?: ContextImportProcessorOptions["fileSystem"];
  /** Depth cap forwarded to the import processor. */
  readonly maxImportDepth?: number;
}

export interface HierarchicalJitInput {
  readonly accessPath: string;
  readonly projectRoot: string;
  readonly options?: HierarchicalJitOptions;
}

export interface JitContextResult {
  /** Concatenated instructional text, home → ancestors → imports, joined with `\n\n`. */
  readonly mergedContents: string;
  /** Absolute paths loaded, in load order. */
  readonly loadedPaths: readonly string[];
  /** Records of skipped contributions (e.g. untrusted workspace). */
  readonly skipped: readonly string[];
  /** Distinct files discovered on the ancestor walk. */
  readonly ancestorFiles: readonly { readonly path: string; readonly relativePath: string }[];
}

const DEFAULT_FILE_NAMES: readonly string[] = ["AGENTS.md"];

function readIfFile(absolutePath: string): string | undefined {
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

function directoryOf(filePath: string): string {
  try {
    const stats = statSync(filePath);
    if (stats.isFile()) {
      return dirname(filePath);
    }
    if (stats.isDirectory()) {
      return filePath;
    }
  } catch {
    // Fall through to dirname.
  }
  return dirname(filePath);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !/^[\\/]/u.test(rel));
}

export function hierarchicalJitContext(input: HierarchicalJitInput): JitContextResult {
  const projectRoot = resolve(input.projectRoot);
  const accessPath = resolve(input.accessPath);
  const opts = input.options ?? {};
  const trust: WorkspaceTrust = opts.trust ?? "trusted";
  const fileNames = opts.fileNames && opts.fileNames.length > 0 ? opts.fileNames : DEFAULT_FILE_NAMES;

  const loadedPaths: string[] = [];
  const textChunks: string[] = [];
  const skipped: string[] = [];

  // 1. Home baseline — always first, never gated by trust.
  for (const home of opts.homeBaselineFiles ?? []) {
    textChunks.push(home.contents);
    loadedPaths.push(home.path);
  }

  // 2. Ancestor chain — root → ... → directory-of-accessPath.
  const ancestorFiles: { readonly path: string; readonly relativePath: string }[] = [];

  if (trust === "untrusted") {
    skipped.push("workspace-untrusted");
  } else if (!isInside(accessPath, projectRoot)) {
    // Access path lives outside the trusted project root; treat as no project
    // contribution. Home baseline already contributed above.
    skipped.push("access-path-outside-project-root");
  } else {
    const accessDirectory = directoryOf(accessPath);
    const chain: string[] = [projectRoot];
    const rel = relative(projectRoot, accessDirectory);
    if (rel && rel !== "" && !rel.startsWith("..")) {
      const segments = rel.split(/[\\/]/u).filter(Boolean);
      let cursor = projectRoot;
      for (const segment of segments) {
        cursor = resolve(cursor, segment);
        chain.push(cursor);
      }
    }

    for (const directory of chain) {
      for (const fileName of fileNames) {
        const candidate = resolve(directory, fileName);
        const contents = readIfFile(candidate);
        if (contents !== undefined) {
          ancestorFiles.push({ path: candidate, relativePath: relative(projectRoot, candidate) || fileName });
          textChunks.push(contents);
          loadedPaths.push(candidate);
        }
      }
    }
  }

  // 3. Import expansion over the assembled chunks (home + ancestors).
  const preImports = textChunks.join("\n\n");

  let mergedContents = preImports;
  if (preImports.length > 0) {
    const importResult: ContextImportProcessorResult = contextImportProcessor(preImports, {
      baseDirectory: projectRoot,
      workspaceRoot: projectRoot,
      ...(opts.fileSystem ? { fileSystem: opts.fileSystem } : {}),
      ...(opts.maxImportDepth !== undefined ? { maxDepth: opts.maxImportDepth } : {})
    });
    mergedContents = importResult.contents;
    for (const loadedPath of importResult.loadedPaths) {
      if (!loadedPaths.includes(loadedPath)) {
        loadedPaths.push(loadedPath);
      }
    }
  }

  return {
    mergedContents,
    loadedPaths,
    skipped,
    ancestorFiles
  };
}
