import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

export interface FileNode {
  readonly path: string;
  /** Path relative to the repository root, normalized to forward slashes. */
  readonly relativePath: string;
  /** Approximate token count for the file's textual map representation. */
  readonly estimatedTokens: number;
  /** Outgoing references to other file nodes by relative path. */
  readonly refs: readonly string[];
}

export interface RepoMapGraph {
  readonly rootPath: string;
  readonly nodes: ReadonlyMap<string, FileNode>;
  /** Normalized relative path -> file path. */
  readonly pathIndex: ReadonlyMap<string, string>;
}

export interface BuildRepoMapGraphOptions {
  /** Repository root directory. */
  readonly rootPath: string;
  /** Relative paths (forward slashes) to include in the graph. */
  readonly filePaths: readonly string[];
  /**
   * Optional predicate to exclude files from reference extraction while still
   * allowing them to appear as targets. Useful for binary or non-source files.
   */
  readonly shouldParse?: (relativePath: string) => boolean;
}

/**
 * Approximate token count: one token per ~4 UTF-8 bytes, minimum 1.
 * Good enough for budget trimming; the rank layer can re-estimate with a
 * real tokenizer if one is attached later.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

/**
 * Build a file graph from a list of relative paths under `rootPath`.
 * Edges are derived from TS/JS-style import/require references and from
 * heuristic same-name references (e.g. `import { foo } from "./foo"` or
 * `require("../utils/foo")`). No tree-sitter required in this packet.
 */
export function buildRepoMapGraph(options: BuildRepoMapGraphOptions): RepoMapGraph {
  const rootPath = resolve(options.rootPath);
  const nodes = new Map<string, FileNode>();
  const pathIndex = new Map<string, string>();

  for (const relativePath of options.filePaths) {
    const normalized = normalizeRelativePath(relativePath);
    const filePath = resolve(rootPath, normalized);
    pathIndex.set(normalized, filePath);
  }

  const shouldParse = options.shouldParse ?? ((relativePath) => isTextSourceFile(relativePath));

  for (const [relativePath, filePath] of pathIndex) {
    if (!shouldParse(relativePath)) {
      nodes.set(relativePath, {
        path: filePath,
        relativePath,
        estimatedTokens: 1,
        refs: []
      });
      continue;
    }

    const text = readTextFile(filePath);
    const refs = extractReferences(text, relativePath, pathIndex);
    nodes.set(relativePath, {
      path: filePath,
      relativePath,
      estimatedTokens: estimateTokens(text),
      refs: [...new Set(refs)]
    });
  }

  return { rootPath, nodes, pathIndex };
}

export interface ScoreRepoMapOptions {
  readonly graph: RepoMapGraph;
  /** Optional seed paths from chat context; these receive a relevance boost. */
  readonly seedPaths?: readonly string[];
  /**
   * Number of PageRank iterations. Default 20; higher values trade speed for
   * convergence, which is rarely needed for small code graphs.
   */
  readonly iterations?: number;
  /** Damping factor. Default 0.85. */
  readonly damping?: number;
  /** Boost multiplier applied to seed nodes. Default 1.5. */
  readonly seedBoost?: number;
}

export interface ScoredNode {
  readonly relativePath: string;
  readonly score: number;
  readonly estimatedTokens: number;
}

/**
 * Score graph nodes with a simple PageRank-like algorithm plus an optional
 * chat-seed boost. Returns a new array sorted by descending score.
 */
export function scoreRepoMap(options: ScoreRepoMapOptions): ScoredNode[] {
  const { graph, seedPaths = [], iterations = 20, damping = 0.85, seedBoost = 1.5 } = options;
  const nodeCount = graph.nodes.size;

  if (nodeCount === 0) {
    return [];
  }

  const seedSet = new Set(seedPaths.map(normalizeRelativePath).filter((p) => graph.nodes.has(p)));
  const keys = [...graph.nodes.keys()].sort();
  const scores = new Map<string, number>();

  for (const key of keys) {
    scores.set(key, 1 / nodeCount);
  }

  for (let i = 0; i < iterations; i += 1) {
    const nextScores = new Map<string, number>();

    for (const key of keys) {
      const node = graph.nodes.get(key);
      if (!node) {
        continue;
      }

      let rank = (1 - damping) / nodeCount;

      for (const ref of node.refs) {
        const target = graph.nodes.get(ref);
        if (!target) {
          continue;
        }
        const outDegree = target.refs.length || 1;
        rank += damping * (scores.get(ref) ?? 0) / outDegree;
      }

      if (seedSet.has(key)) {
        rank *= seedBoost;
      }

      nextScores.set(key, rank);
    }

    const sum = [...nextScores.values()].reduce((a, b) => a + b, 0);
    for (const key of keys) {
      const normalized = (nextScores.get(key) ?? 0) / (sum || 1);
      scores.set(key, normalized);
    }
  }

  return keys
    .map((key) => {
      const node = graph.nodes.get(key)!;
      return {
        relativePath: key,
        score: scores.get(key) ?? 0,
        estimatedTokens: node.estimatedTokens
      };
    })
    .sort((a, b) => b.score - a.score);
}

const IMPORT_PATTERN =
  /(?:^|[\s;])import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]|(?:^|[\s;])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gmu;

/**
 * Extract relative-path references from source text. Only resolves references
 * that stay inside the repo and match entries in the path index.
 */
export function extractReferences(
  text: string,
  sourceRelativePath: string,
  pathIndex: ReadonlyMap<string, string>
): string[] {
  const refs: string[] = [];
  const sourceDir = sourceRelativePath.includes("/") ? sourceRelativePath.replace(/\/[^/]+$/u, "") : "";

  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const spec = (match[1] ?? match[2] ?? "").trim();
    if (!spec || spec.startsWith("http") || spec.startsWith("data:")) {
      continue;
    }

    const resolved = resolveImportSpecifier(spec, sourceDir);
    if (!resolved) {
      continue;
    }

    // Try exact match first, then common source extensions.
    const candidates = candidatePaths(resolved);
    for (const candidate of candidates) {
      if (pathIndex.has(candidate)) {
        refs.push(candidate);
        break;
      }
    }
  }

  return refs;
}

function resolveImportSpecifier(spec: string, sourceDir: string): string | undefined {
  if (spec.startsWith("/")) {
    return spec.slice(1);
  }

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = sourceDir ? `${sourceDir}/${spec}` : spec;
    return normalizeRelativePath(base);
  }

  // Bare specifiers (e.g. "lodash") are not resolved to local files in this
  // packet; they are skipped to avoid false graph edges.
  return undefined;
}

function candidatePaths(resolved: string): string[] {
  if (resolved.endsWith("/")) {
    return ["index.ts", "index.js"].map((name) => `${resolved}${name}`);
  }

  const base = [resolved];
  const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];

  for (const ext of extensions) {
    if (!resolved.endsWith(ext)) {
      base.push(`${resolved}${ext}`);
    }
  }

  return base;
}

function readTextFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function isTextSourceFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx");
}

export function normalizeRelativePath(input: string): string {
  return relative(resolve("/"), resolve("/", input.replace(/\\/gu, "/"))).replace(/\/+/gu, "/");
}

export interface RankedRepoMapOptions {
  readonly graph: RepoMapGraph;
  /** Maximum tokens to include in the output. */
  readonly budgetTokens?: number;
  /** Relative paths from chat context that should be boosted. */
  readonly seedPaths?: readonly string[];
  /** When true, budget is ignored and the entire ranked map is returned. */
  readonly expand?: boolean;
}

export interface RankedRepoMapEntry {
  readonly relativePath: string;
  readonly score: number;
  readonly estimatedTokens: number;
  /** File contents when the caller requests a textual map; omitted for compact. */
  readonly contents?: string;
}

export interface RankedRepoMap {
  readonly rootPath: string;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly expanded: boolean;
  readonly entries: readonly RankedRepoMapEntry[];
}

/**
 * Emit a ranked repository map trimmed to a token budget. When `expand` is true
 * or `budgetTokens` is undefined, the full ranked map is returned and
 * `usedTokens` equals the total estimate.
 */
export function rankRepoMap(options: RankedRepoMapOptions): RankedRepoMap {
  const { graph, budgetTokens = 1000, seedPaths = [], expand = false } = options;
  const scored = scoreRepoMap({ graph, seedPaths });

  if (expand || typeof budgetTokens !== "number") {
    const total = scored.reduce((sum, node) => sum + node.estimatedTokens, 0);
    return {
      rootPath: graph.rootPath,
      budgetTokens,
      usedTokens: total,
      expanded: true,
      entries: scored.map((node) => ({ ...node }))
    };
  }

  const entries: RankedRepoMapEntry[] = [];
  let usedTokens = 0;

  for (const node of scored) {
    if (usedTokens + node.estimatedTokens > budgetTokens) {
      break;
    }

    entries.push({ ...node });
    usedTokens += node.estimatedTokens;
  }

  return {
    rootPath: graph.rootPath,
    budgetTokens,
    usedTokens,
    expanded: false,
    entries
  };
}

export function renderRepoMap(map: RankedRepoMap): string {
  const lines = [map.rootPath, ""];

  for (const entry of map.entries) {
    const score = entry.score.toFixed(6);
    const tokens = entry.estimatedTokens;
    lines.push(`${entry.relativePath} score=${score} tokens=${tokens}`);
  }

  return lines.join("\n");
}

export function renderRepoMapJson(map: RankedRepoMap): string {
  return JSON.stringify(
    {
      rootPath: map.rootPath,
      budgetTokens: map.budgetTokens,
      usedTokens: map.usedTokens,
      expanded: map.expanded,
      entries: map.entries.map((entry) => ({
        relativePath: entry.relativePath,
        score: entry.score,
        estimatedTokens: entry.estimatedTokens
      }))
    },
    null,
    2
  );
}

export function buildRepoMapFromFileSystem(options: {
  readonly rootPath: string;
  readonly filePaths: readonly string[];
}): RepoMapGraph {
  return buildRepoMapGraph({
    rootPath: options.rootPath,
    filePaths: options.filePaths,
    shouldParse: (relativePath) => isTextSourceFile(relativePath)
  });
}

export function buildRepoMapForRoot(options: {
  readonly rootPath: string;
  readonly filePaths: readonly string[];
  readonly seedPaths?: readonly string[];
  readonly budgetTokens?: number;
  readonly expand?: boolean;
}): RankedRepoMap {
  const graph = buildRepoMapFromFileSystem({
    rootPath: options.rootPath,
    filePaths: options.filePaths
  });

  return rankRepoMap({
    graph,
    seedPaths: options.seedPaths,
    budgetTokens: options.budgetTokens,
    expand: options.expand
  });
}
