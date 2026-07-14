import { Pool } from "pg";

import type { MemoryPostgresConfig, MemoryStorageConfig } from "../config/schema.js";
import { extractLinks } from "./frontmatter.js";
import {
  buildMemoryGetResult,
  planPreflightedMemoryRemember,
  preflightMemoryRemember,
  searchMemoryEntries,
  type MemoryFactEntry
} from "./policy.js";
import {
  MemoryFactSchema,
  type MemoryDoctorReport,
  type MemoryForgetInput,
  type MemoryGetResult,
  type MemoryRememberInput,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemoryStoreStatus,
  type MemoryWriteResult
} from "./schemas.js";
import type { FileMemoryStore } from "./store.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * The small contract shared by file-backed and PostgreSQL-backed fact stores.
 * It deliberately describes facts only; garage/role operational state stays in
 * its existing local file store rather than pretending it is user memory.
 */
export interface MemoryFactStore {
  readonly provider: "markdown" | "postgres";
  readonly directory: string;
  status(): Promise<MemoryStoreStatus>;
  remember(input: MemoryRememberInput): MaybePromise<MemoryWriteResult>;
  get(name: string): MaybePromise<MemoryGetResult>;
  search(input: MemorySearchInput): MaybePromise<MemorySearchResult>;
  forget(input: MemoryForgetInput): MaybePromise<MemoryWriteResult>;
  list(): MaybePromise<readonly MemoryFactEntry[]>;
  doctor(): MaybePromise<MemoryDoctorReport>;
  close?(): Promise<void>;
}

interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresPoolLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
  end?(): Promise<void>;
}

export interface PostgresMemoryStoreOptions {
  readonly config: MemoryPostgresConfig;
  /** A stable logical partition. The default intentionally contains no local path. */
  readonly namespace?: string;
  readonly sessionId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Test seam; production constructs a standard pg Pool lazily. */
  readonly poolFactory?: (connectionString: string, ssl: MemoryPostgresConfig["ssl"]) => PostgresPoolLike;
}

interface FactRow extends Record<string, unknown> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly type: string;
  readonly confidence: number;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
  readonly origin_session_id: string | null;
}

/** Wrap the proven Markdown implementation without changing its synchronous contract. */
export function createMarkdownMemoryStore(store: FileMemoryStore): MemoryFactStore {
  return {
    provider: "markdown",
    directory: store.directory,
    async status() {
      return {
        provider: "markdown",
        status: "ready",
        summary: "Markdown fact memory is ready.",
        missingEnvNames: [],
        location: store.directory
      };
    },
    remember: (input) => store.remember(input),
    get: (name) => store.get(name),
    search: (input) => store.search(input),
    forget: (input) => store.forget(input),
    list: () => store.list(),
    doctor: () => store.doctor()
  };
}

/**
 * Create a generic PostgreSQL fact store. It owns only its configured schema/table,
 * uses parameterized values throughout, and never returns a connection string.
 */
export function createPostgresMemoryStore(options: PostgresMemoryStoreOptions): MemoryFactStore {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const namespace = options.namespace ?? "global";
  const { config } = options;
  const table = `"${config.schema}"."${config.table}"`;
  const indexPrefix = `${config.schema}_${config.table}`;
  const location = `postgres:${config.schema}.${config.table}/${namespace}`;
  let pool: PostgresPoolLike | null = null;
  let initialized = false;

  const connectionString = (): string | null => {
    const candidate = env[config.connectionStringEnvVar];
    return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
  };

  const getPool = (): PostgresPoolLike | null => {
    if (pool) {
      return pool;
    }
    const connection = connectionString();
    if (!connection) {
      return null;
    }
    pool =
      options.poolFactory?.(connection, config.ssl) ??
      new Pool({
        connectionString: connection,
        ...(config.ssl === "disable" ? { ssl: false } : config.ssl === "require" ? { ssl: { rejectUnauthorized: false } } : {})
      });
    return pool;
  };

  const ensureSchema = async (): Promise<PostgresPoolLike> => {
    const activePool = getPool();
    if (!activePool) {
      throw new MemoryStoreUnavailableError("missing-env");
    }
    if (!initialized) {
      await activePool.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
      await activePool.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          namespace text NOT NULL,
          name text NOT NULL,
          title text NOT NULL,
          description text NOT NULL,
          body text NOT NULL,
          type text NOT NULL,
          confidence double precision NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          origin_session_id text,
          deleted_at timestamptz,
          forget_reason text,
          PRIMARY KEY (namespace, name)
        )`
      );
      await activePool.query(`CREATE INDEX IF NOT EXISTS "${indexPrefix}_active_updated_idx" ON ${table} (namespace, updated_at DESC) WHERE deleted_at IS NULL`);
      initialized = true;
    }
    return activePool;
  };

  const listEntries = async (): Promise<readonly MemoryFactEntry[]> => {
    try {
      const activePool = await ensureSchema();
      const result = await activePool.query<FactRow>(
        `SELECT name, title, description, body, type, confidence, created_at, updated_at, origin_session_id
         FROM ${table}
         WHERE namespace = $1 AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
        [namespace]
      );
      return result.rows.map(rowToEntry);
    } catch {
      throw new MemoryStoreUnavailableError("offline");
    }
  };

  return {
    provider: "postgres",
    directory: location,

    async status() {
      if (!connectionString()) {
        return {
          provider: "postgres",
          status: "missing-env",
          summary: `PostgreSQL memory needs the ${config.connectionStringEnvVar} environment variable.`,
          missingEnvNames: [config.connectionStringEnvVar],
          location
        };
      }
      try {
        // A reachable server is not enough: prove this configured identity can
        // also create/use Guru's own isolated schema and fact table.
        await ensureSchema();
        return {
          provider: "postgres",
          status: "ready",
          summary: "PostgreSQL memory is reachable and its fact table is ready.",
          missingEnvNames: [],
          location
        };
      } catch (error) {
        return {
          provider: "postgres",
          status: error instanceof MemoryStoreUnavailableError ? error.status : "offline",
          summary: "PostgreSQL memory could not be reached. Check the configured connection environment variable and database availability.",
          missingEnvNames: [],
          location
        };
      }
    },

    async remember(rawInput) {
      const preflight = preflightMemoryRemember(rawInput);
      if (preflight.kind === "blocked") {
        return preflight.result;
      }

      try {
        const entries = await listEntries();
        const timestamp = now().toISOString();
        const plan = planPreflightedMemoryRemember(preflight, entries, {
          timestamp,
          ...(options.sessionId ? { sessionId: options.sessionId } : {})
        });
        if (plan.kind === "blocked") {
          return plan.result;
        }
        const activePool = await ensureSchema();

        if (plan.kind === "update") {
          await activePool.query(
            `UPDATE ${table}
             SET title = $3, description = $4, body = $5, type = $6, confidence = $7, updated_at = $8, deleted_at = NULL, forget_reason = NULL
             WHERE namespace = $1 AND name = $2`,
            [namespace, plan.name, plan.fact.title, plan.fact.description, plan.body, plan.fact.type, plan.fact.confidence, plan.fact.updatedAt]
          );
          return plan.result;
        }

        await activePool.query(
          `INSERT INTO ${table} (namespace, name, title, description, body, type, confidence, created_at, updated_at, origin_session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
          [
            namespace,
            plan.name,
            plan.fact.title,
            plan.fact.description,
            plan.body,
            plan.fact.type,
            plan.fact.confidence,
            plan.fact.createdAt,
            plan.fact.originSessionId ?? null
          ]
        );
        return plan.result;
      } catch {
        return {
          status: "blocked",
          summary: "PostgreSQL memory is unavailable; the fact was not written. Check /memory status and try again.",
          blockers: ["postgres-unavailable"]
        };
      }
    },

    async get(name) {
      try {
        const entries = await listEntries();
        return buildMemoryGetResult(name, entries, now());
      } catch {
        return { found: false, links: [], backlinks: [], danglingLinks: [], summary: "PostgreSQL memory is unavailable; no fact was read." };
      }
    },

    async search(rawInput) {
      const entries = await listEntries();
      return searchMemoryEntries(rawInput, entries);
    },

    async forget(input) {
      try {
        const activePool = await ensureSchema();
        const result = await activePool.query(
          `UPDATE ${table} SET deleted_at = $3, forget_reason = $4 WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL`,
          [namespace, input.name, now().toISOString(), input.reason]
        );
        if ((result.rowCount ?? 0) === 0) {
          return { status: "blocked", summary: `No memory fact named '${input.name}'.`, blockers: ["not-found"] };
        }
        return { status: "forgotten", name: input.name, summary: `Soft-deleted [[${input.name}]] in PostgreSQL memory. Reason recorded.`, blockers: [] };
      } catch {
        return {
          status: "blocked",
          summary: "PostgreSQL memory is unavailable; the fact was not changed.",
          blockers: ["postgres-unavailable"]
        };
      }
    },

    list: listEntries,

    async doctor() {
      try {
        const entries = await listEntries();
        const names = new Set(entries.map((entry) => entry.fact.name));
        const danglingLinks = entries.flatMap((entry) => extractLinks(entry.body).filter((link) => !names.has(link)).map((link) => `${entry.fact.name} -> [[${link}]]`));
        return {
          directory: location,
          factCount: entries.length,
          corruptSkipped: [],
          orphanTempsRemoved: 0,
          trashRemoved: 0,
          danglingLinks,
          indexRebuilt: false,
          summary: `${entries.length} PostgreSQL fact(s); ${danglingLinks.length} dangling link(s). Database schema/table verified.`
        };
      } catch {
        return {
          directory: location,
          factCount: 0,
          corruptSkipped: [],
          orphanTempsRemoved: 0,
          trashRemoved: 0,
          danglingLinks: [],
          indexRebuilt: false,
          summary: "PostgreSQL memory is unavailable; no repair was attempted."
        };
      }
    },

    async close() {
      if (pool?.end) {
        await pool.end();
      }
      pool = null;
      initialized = false;
    }
  };
}

export function createConfiguredMemoryStore(config: MemoryStorageConfig, markdown: FileMemoryStore, options: Omit<PostgresMemoryStoreOptions, "config"> = {}): MemoryFactStore {
  return config.provider === "postgres" ? createPostgresMemoryStore({ ...options, config: config.postgres }) : createMarkdownMemoryStore(markdown);
}

function rowToEntry(row: FactRow): MemoryFactEntry {
  const fact = MemoryFactSchema.parse({
    name: row.name,
    title: row.title,
    description: row.description,
    type: row.type,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    confidence: row.confidence,
    ...(row.origin_session_id ? { originSessionId: row.origin_session_id } : {})
  });
  return { fact, body: row.body };
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

class MemoryStoreUnavailableError extends Error {
  constructor(readonly status: "missing-env" | "offline" | "error") {
    super(status);
  }
}
