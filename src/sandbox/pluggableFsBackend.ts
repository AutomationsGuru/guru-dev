import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pluggable filesystem backend interface.
 * Read/write/list contract for sandbox isolation and test injection.
 */
export interface FsBackend {
  readonly read: (path: string) => string;
  readonly write: (path: string, content: string) => void;
  readonly list: (dir: string) => readonly string[];
}

/**
 * Options for LocalFsBackend.
 */
export interface LocalFsBackendOptions {
  /** Base directory for relative paths. Defaults to process.cwd(). */
  readonly root?: string;
}

/**
 * Factory for the default local filesystem backend.
 * Uses injectable root for test/sandbox scoping.
 */
export function createLocalFsBackend(options: LocalFsBackendOptions = {}): FsBackend {
  const root = options.root ?? process.cwd();

  return {
    read(path: string): string {
      const fullPath = join(root, path);
      return readFileSync(fullPath, "utf8");
    },

    write(path: string, content: string): void {
      const fullPath = join(root, path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, content, "utf8");
    },

    list(dir: string): readonly string[] {
      const fullPath = join(root, dir);
      if (!existsSync(fullPath)) {
        return [];
      }
      return readdirSync(fullPath);
    }
  };
}

/**
 * In-memory backend for isolated tests and sandbox scenarios.
 * Injectable via map for pluggable composition.
 */
export function createMemoryFsBackend(initialFiles: Record<string, string> = {}): FsBackend {
  const store = new Map<string, string>(Object.entries(initialFiles));

  return {
    read(path: string): string {
      const content = store.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },

    write(path: string, content: string): void {
      store.set(path, content);
    },

    list(dir: string): readonly string[] {
      // Simple prefix match for directory listing
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...store.keys()]
        .filter((key) => key.startsWith(dir) || key.startsWith(prefix))
        .map((key) => key.slice(dir.length).replace(/^\//, ""))
        .filter(Boolean);
    }
  };
}

/**
 * Pluggable FS facade using injectable backend map.
 * Default backend key: "local". Override or extend map for sandboxing.
 */
export interface PluggableFs {
  readonly use: (key: string) => FsBackend;
  readonly register: (key: string, backend: FsBackend) => void;
  readonly defaultKey: string;
}

export function createPluggableFs(
  initialBackends: Map<string, FsBackend> = new Map(),
  defaultKey = "local"
): PluggableFs {
  const backends = new Map(initialBackends);

  if (!backends.has(defaultKey)) {
    backends.set(defaultKey, createLocalFsBackend());
  }

  return {
    defaultKey,

    use(key: string): FsBackend {
      const backend = backends.get(key);
      if (!backend) {
        throw new Error(`FsBackend not registered: ${key}`);
      }
      return backend;
    },

    register(key: string, backend: FsBackend): void {
      backends.set(key, backend);
    }
  };
}
