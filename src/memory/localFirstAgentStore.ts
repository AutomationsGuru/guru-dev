import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * Local-first agent store (IDEA-F197, R-LT-LOCAL-STORE, 2026-07-19).
 *
 * The filesystem substrate for durable, long-lived agents under a profile
 * root — the layout half of the Letta-review "local agent persistence"
 * residual, with no Letta cloud and no Constellation:
 *
 *   <root>/agents/<agentId>/meta.json          — identity/record metadata
 *   <root>/agents/<agentId>/blocks/<label>.md  — named memory blocks
 *
 * This module owns pure path helpers plus meta serialize/load. Block
 * read/write and identity semantics live in the composing lanes
 * (F174 agentIdentityMemory, F177 versionedMemoryStore); this store is the
 * shared on-disk layout those organs can agree on. Local-first means the
 * filesystem is the source of truth — every record is a plain file, atomic
 * (tmp+rename) on write, git-friendly (canonical pretty JSON), and readable
 * without any service running.
 *
 * Safety: agent ids are validated slugs; every resolved path is asserted to
 * stay under the agents root (traversal-proof). Loads are skip-and-report —
 * a missing or malformed meta.json returns undefined, never throws, matching
 * the L1 store's parseFactFile contract so one corrupt agent never takes
 * down the boot.
 */

const AGENTS_SUBDIR = "agents";
const META_FILENAME = "meta.json";
const BLOCKS_SUBDIR = "blocks";

/**
 * Agent id = filename-safe slug. Deliberately narrower than any string: ids
 * become directory names, so path separators, dots, and whitespace are out.
 * Kebab / snake / alphanumerics (F174's `agent-<uuid>` form included).
 */
export const AgentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, "agent ids are filename-safe slugs (alphanumeric start, then [A-Za-z0-9_-], 1-128 chars)");

export type AgentId = z.infer<typeof AgentIdSchema>;

/** The versioned, serializable per-agent metadata record (meta.json). */
export const LocalAgentMetaSchema = z
  .object({
    agentId: AgentIdSchema,
    version: z.literal(1),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1)
  })
  .strict();

export type LocalAgentMeta = z.infer<typeof LocalAgentMetaSchema>;

/** The resolved on-disk locations for one agent under a profile root. */
export interface LocalAgentPaths {
  /** <root>/agents/<agentId> */
  readonly agentDir: string;
  /** <root>/agents/<agentId>/meta.json */
  readonly metaFile: string;
  /** <root>/agents/<agentId>/blocks */
  readonly blocksDir: string;
}

export interface LocalFirstAgentStore {
  /** The profile root this store is bound to. */
  readonly root: string;
  /** <root>/agents */
  readonly agentsRoot: string;
  pathsFor(agentId: string): LocalAgentPaths;
  /** Persist meta atomically (tmp+rename); creates agentDir + blocks/. */
  saveMeta(meta: LocalAgentMeta): void;
  /** Load meta.json, or undefined if missing / malformed. */
  loadMeta(agentId: string): LocalAgentMeta | undefined;
  /** Saved agent ids with valid meta, sorted; corrupt entries skipped. */
  listAgents(): readonly string[];
}

export interface LocalFirstAgentStoreOptions {
  /** Profile root (the directory that will hold agents/). */
  readonly root: string;
}

/** The agents namespace under a profile root. Pure — no I/O. */
export function resolveAgentsRoot(root: string): string {
  return join(root, AGENTS_SUBDIR);
}

/**
 * Resolve the on-disk paths for one agent, or throw if the id is not a safe
 * slug or the resolved directory would escape the agents root. The root-side
 * containment check is structural (resolve + prefix), so it holds even if the
 * slug schema is ever loosened.
 */
export function pathsFor(root: string, agentId: string): LocalAgentPaths {
  const id = AgentIdSchema.parse(agentId);
  const agentsRoot = resolveAgentsRoot(root);
  const agentDir = join(agentsRoot, id);
  const resolvedDir = resolve(agentDir);
  if (!resolvedDir.startsWith(resolve(agentsRoot) + sep)) {
    throw new Error(`agent id escapes the agents root: ${agentId}`);
  }
  return {
    agentDir: resolvedDir,
    metaFile: join(resolvedDir, META_FILENAME),
    blocksDir: join(resolvedDir, BLOCKS_SUBDIR)
  };
}

/** Canonical JSON form — stable key order, 2-space indent, trailing newline. */
export function serializeAgentMeta(meta: LocalAgentMeta): string {
  const parsed = LocalAgentMetaSchema.parse(meta);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Parse serialized meta JSON; returns undefined on any malformed input. */
export function deserializeAgentMeta(text: string): LocalAgentMeta | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = LocalAgentMetaSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function createLocalFirstAgentStore(options: LocalFirstAgentStoreOptions): LocalFirstAgentStore {
  const root = options.root;
  const agentsRoot = resolveAgentsRoot(root);

  const writeAtomic = (path: string, content: string): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  };

  const loadMeta = (agentId: string): LocalAgentMeta | undefined => {
    const paths = pathsFor(root, agentId);
    if (!existsSync(paths.metaFile)) {
      return undefined;
    }
    try {
      return deserializeAgentMeta(readFileSync(paths.metaFile, "utf8"));
    } catch {
      return undefined;
    }
  };

  return {
    root,
    agentsRoot,

    pathsFor(agentId) {
      return pathsFor(root, agentId);
    },

    saveMeta(meta) {
      const parsed = LocalAgentMetaSchema.parse(meta);
      const paths = pathsFor(root, parsed.agentId);
      mkdirSync(paths.blocksDir, { recursive: true });
      writeAtomic(paths.metaFile, serializeAgentMeta(parsed));
    },

    loadMeta,

    listAgents() {
      if (!existsSync(agentsRoot)) {
        return [];
      }
      const ids: string[] = [];
      for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !AgentIdSchema.safeParse(entry.name).success) {
          continue;
        }
        const meta = loadMeta(entry.name);
        if (meta) {
          ids.push(meta.agentId);
        }
      }
      return ids.sort();
    }
  };
}
