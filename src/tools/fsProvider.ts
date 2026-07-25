/**
 * Workspace FS provider slot (IDEA-F331-FSPROV-01).
 *
 * Abstract read/write/list behind FsProvider so tools and sandbox layers can
 * operate against any backing store — real disk, memory, or future providers —
 * without coupling to the host filesystem.
 */

/**
 * Minimal filesystem abstraction for workspace operations.
 *
 * All paths use forward-slash separators. Directory entries returned by `list`
 * end with `"/"`; plain file entries do not.
 */
export interface FsProvider {
  /** Read the full text content at `path`. Throws if the path does not exist. */
  readText(path: string): Promise<string>;

  /** Write `content` to `path`, creating or overwriting. */
  writeText(path: string, content: string): Promise<void>;

  /**
   * List entry names directly inside the directory at `dirPath`.
   *
   * Returned names are relative to `dirPath` (not full paths). Directory
   * entries end with `"/"`. The list is unordered.
   */
  list(dirPath: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// MemoryFsProvider
// ---------------------------------------------------------------------------

/**
 * In-memory {@link FsProvider} backed by a `Map<string, string>`.
 *
 * Designed for isolated tests and sandbox layers that do not require real disk
 * access. Each instance is fully independent.
 */
export class MemoryFsProvider implements FsProvider {
  readonly #store = new Map<string, string>();

  async readText(path: string): Promise<string> {
    const normalized = normalizePath(path);

    if (!this.#store.has(normalized)) {
      throw new Error(`ENOENT: no such file ${normalized}`);
    }

    return this.#store.get(normalized)!;
  }

  async writeText(path: string, content: string): Promise<void> {
    this.#store.set(normalizePath(path), content);
  }

  async list(dirPath: string): Promise<string[]> {
    const normalized = normalizeDirPath(dirPath);
    const prefix = normalized === "/" ? "/" : normalized.endsWith("/") ? normalized : `${normalized}/`;
    const seen = new Set<string>();

    for (const filePath of this.#store.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }

      const relative = filePath.slice(prefix.length);
      const slashIdx = relative.indexOf("/");

      if (slashIdx === -1) {
        // Direct child file
        seen.add(relative);
      } else {
        // Direct child directory
        seen.add(`${relative.slice(0, slashIdx + 1)}`);
      }
    }

    return [...seen];
  }
}

/**
 * Create a fresh, empty {@link MemoryFsProvider}.
 */
export function createMemoryFsProvider(): MemoryFsProvider {
  return new MemoryFsProvider();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePath(raw: string): string {
  // Strip leading/trailing whitespace; ensure a leading slash.
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeDirPath(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0 || trimmed === "/") {
    return "/";
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

  // Normalize trailing slash — the prefix-matching logic in list() handles
  // both cases, but we return a consistent form here.
  return withSlash.endsWith("/") ? withSlash : `${withSlash}/`;
}
