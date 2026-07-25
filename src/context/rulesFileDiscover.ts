import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Default discovery/merge order for project rule files.
 * Earlier names are higher priority and appear earlier in the returned merge list.
 * AGENTS.md is first so DOX/AGENTS remains the primary rail when multiple rule files exist.
 */
export const DEFAULT_RULES_FILE_NAMES: readonly string[] = [
  "AGENTS.md",
  "RULES.md",
  ".clinerules",
  "CLAUDE.md"
];

export interface DiscoverRulesFilesOptions {
  /** Ordered basenames to look for under cwd. Defaults to DEFAULT_RULES_FILE_NAMES. Order = merge order. */
  readonly names?: readonly string[];
  /** Injectable existence check (tests). Defaults to fs.existsSync. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Discover existing project rule files under `cwd`.
 *
 * Returns absolute paths of files that exist, in `names` order (documented merge order:
 * earlier names are higher priority / earlier in the returned list). Missing names are
 * skipped. Never returns secret files (e.g. `.env` / `.env.local`) even if listed in `names`.
 * Names are treated as basenames only (joined under `cwd`).
 */
export function discoverRulesFiles(cwd: string, options: DiscoverRulesFilesOptions = {}): string[] {
  const names = options.names ?? DEFAULT_RULES_FILE_NAMES;
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const root = resolve(cwd);
  const found: string[] = [];

  for (const name of names) {
    const base = basename(name);
    if (!base || isSecretRulesFileName(base)) {
      continue;
    }
    const candidate = join(root, base);
    if (exists(candidate)) {
      found.push(candidate);
    }
  }

  return found;
}

/**
 * True if basename must never be treated as a rules file (secret / credential).
 * Rejects `.env` and anything starting with `.env.` (e.g. `.env.local`, `.env.production`).
 */
export function isSecretRulesFileName(name: string): boolean {
  const base = basename(name).toLowerCase();
  return base === ".env" || base.startsWith(".env.");
}
