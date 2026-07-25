import { z } from "zod";

import type { ToolDefinition } from "./registry.js";

// ---------------------------------------------------------------------------
// FsProvider — minimal abstract read / write / list interface
// ---------------------------------------------------------------------------

/**
 * A pluggable filesystem provider that supports reading, writing, and
 * listing directory entries. Each implementation owns its namespace so two
 * instances of the same type are fully isolated.
 *
 * Paths use forward-slash separators. Directory entries returned by
 * {@link list} end with `"/"` so callers can distinguish files from
 * directories without a secondary stat call.
 */
export interface FsProvider {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  list(dirPath: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function normalizeDirPath(raw: string): string {
  const cleaned = normalizePath(raw);
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

// ---------------------------------------------------------------------------
// MemoryFsProvider
// ---------------------------------------------------------------------------

/**
 * In-memory {@link FsProvider} backed by `Map<string, string>`. Each
 * instance is fully independent so two MemoryFsProviders share no state,
 * making them useful for isolated tests, workspace snapshots, and VFS
 * experimentation.
 */
export class MemoryFsProvider implements FsProvider {
  readonly #store = new Map<string, string>();

  async readText(path: string): Promise<string> {
    const key = normalizePath(path);
    const content = this.#store.get(key);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file: ${key}`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }
    return content;
  }

  async writeText(path: string, content: string): Promise<void> {
    this.#store.set(normalizePath(path), content);
  }

  async list(dirPath: string): Promise<string[]> {
    const prefix = normalizeDirPath(dirPath);
    const seen = new Set<string>();

    for (const key of this.#store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      const firstSegment = relative.split("/", 1)[0] ?? "";
      if (firstSegment.length === 0) continue;
      seen.add(firstSegment);
    }

    // Synthesise directory entries — any key deeper than one segment past
    // the prefix means there's a subdirectory.
    for (const key of this.#store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      const segments = relative.split("/");
      // Only keys whose first segment matches an existing child AND who have
      // deeper entries create directory entries.
      if (segments.length < 2) continue;
      const dir = `${segments[0]}/`;
      seen.add(dir);
    }

    return [...seen].sort();
  }
}

// ---------------------------------------------------------------------------
// Tool-definition factory — one slot that produces read / write / list tools
// for any FsProvider
// ---------------------------------------------------------------------------

export const WorkspaceFsReadInputSchema = z
  .object({
    path: z.string().trim().min(1).describe("Forward-slash file path to read (e.g. /docs/notes.txt).")
  })
  .strict();

export const WorkspaceFsReadOutputSchema = z
  .object({
    ok: z.boolean(),
    path: z.string(),
    content: z.string().optional(),
    error: z.string().optional()
  })
  .strict();

export type WorkspaceFsReadInput = z.infer<typeof WorkspaceFsReadInputSchema>;
export type WorkspaceFsReadOutput = z.infer<typeof WorkspaceFsReadOutputSchema>;

export const WorkspaceFsWriteInputSchema = z
  .object({
    path: z.string().trim().min(1).describe("Forward-slash file path to write (e.g. /docs/notes.txt). Intermediate paths are not implicitly created; only files are stored."),
    content: z.string().describe("File content.")
  })
  .strict();

export const WorkspaceFsWriteOutputSchema = z
  .object({
    ok: z.boolean(),
    path: z.string(),
    error: z.string().optional()
  })
  .strict();

export type WorkspaceFsWriteInput = z.infer<typeof WorkspaceFsWriteInputSchema>;
export type WorkspaceFsWriteOutput = z.infer<typeof WorkspaceFsWriteOutputSchema>;

export const WorkspaceFsListInputSchema = z
  .object({
    dirPath: z.string().trim().min(1).describe("Forward-slash directory path to list (e.g. /docs).")
  })
  .strict();

export const WorkspaceFsListOutputSchema = z
  .object({
    ok: z.boolean(),
    dirPath: z.string(),
    entries: z.array(z.string()).optional(),
    error: z.string().optional()
  })
  .strict();

export type WorkspaceFsListInput = z.infer<typeof WorkspaceFsListInputSchema>;
export type WorkspaceFsListOutput = z.infer<typeof WorkspaceFsListOutputSchema>;

export interface WorkspaceFsProviderSlot {
  /** Create tool definitions bound to the given provider. */
  createReadTool(provider: FsProvider): ToolDefinition<typeof WorkspaceFsReadInputSchema, typeof WorkspaceFsReadOutputSchema>;
  createWriteTool(provider: FsProvider): ToolDefinition<typeof WorkspaceFsWriteInputSchema, typeof WorkspaceFsWriteOutputSchema>;
  createListTool(provider: FsProvider): ToolDefinition<typeof WorkspaceFsListInputSchema, typeof WorkspaceFsListOutputSchema>;
}

/**
 * Return a frozen tool slot. Every call to `createReadTool` / `createWriteTool`
 * / `createListTool` builds new tool definitions bound to the supplied
 * provider — no shared mutable state across definitions.
 */
export function createWorkspaceFsProviderSlot(): WorkspaceFsProviderSlot {
  return Object.freeze({
    createReadTool(provider: FsProvider) {
      const tool: ToolDefinition<typeof WorkspaceFsReadInputSchema, typeof WorkspaceFsReadOutputSchema> = {
        id: "workspace_fs.read",
        title: "Workspace FS Read",
        description: "Read a text file from the workspace filesystem provider. Paths are forward-slash relative to the provider root.",
        inputSchema: WorkspaceFsReadInputSchema,
        outputSchema: WorkspaceFsReadOutputSchema,
        effect: "read-only",
        async execute(input) {
          try {
            const content = await provider.readText(input.path);
            return { ok: true, path: input.path, content };
          } catch (err) {
            return { ok: false, path: input.path, error: err instanceof Error ? err.message : String(err) };
          }
        }
      };
      return tool;
    },

    createWriteTool(provider: FsProvider) {
      const tool: ToolDefinition<typeof WorkspaceFsWriteInputSchema, typeof WorkspaceFsWriteOutputSchema> = {
        id: "workspace_fs.write",
        title: "Workspace FS Write",
        description: "Write text content to a file in the workspace filesystem provider.",
        inputSchema: WorkspaceFsWriteInputSchema,
        outputSchema: WorkspaceFsWriteOutputSchema,
        effect: "mutating",
        async execute(input) {
          try {
            await provider.writeText(input.path, input.content);
            return { ok: true, path: input.path };
          } catch (err) {
            return { ok: false, path: input.path, error: err instanceof Error ? err.message : String(err) };
          }
        }
      };
      return tool;
    },

    createListTool(provider: FsProvider) {
      const tool: ToolDefinition<typeof WorkspaceFsListInputSchema, typeof WorkspaceFsListOutputSchema> = {
        id: "workspace_fs.list",
        title: "Workspace FS List",
        description: "List entries in the workspace filesystem provider directory.",
        inputSchema: WorkspaceFsListInputSchema,
        outputSchema: WorkspaceFsListOutputSchema,
        effect: "read-only",
        async execute(input) {
          try {
            const entries = await provider.list(input.dirPath);
            return { ok: true, dirPath: input.dirPath, entries };
          } catch (err) {
            return { ok: false, dirPath: input.dirPath, error: err instanceof Error ? err.message : String(err) };
          }
        }
      };
      return tool;
    }
  });
}