import { createPostgresMemoryStore, type PostgresPoolLike } from "../../src/memory/provider.js";
import { MemoryPostgresConfigSchema } from "../../src/config/schema.js";

interface StoredRow extends Record<string, unknown> {
  namespace: string;
  name: string;
  title: string;
  description: string;
  body: string;
  type: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  origin_session_id: string | null;
  deleted_at: string | null;
  forget_reason: string | null;
}

class FakePostgresPool implements PostgresPoolLike {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly rows: StoredRow[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<{ rows: readonly Row[]; rowCount?: number }> {
    this.calls.push({ text, values });
    if (text === "SELECT 1" || text.startsWith("CREATE ")) {
      return { rows: [] };
    }
    if (text.startsWith("SELECT name")) {
      const namespace = values[0];
      return { rows: this.rows.filter((row) => row.namespace === namespace && row.deleted_at === null).map((row) => ({ ...row })) as unknown as readonly Row[] };
    }
    if (text.startsWith("INSERT INTO")) {
      const [namespace, name, title, description, body, type, confidence, timestamp, originSessionId] = values;
      this.rows.push({
        namespace: String(namespace),
        name: String(name),
        title: String(title),
        description: String(description),
        body: String(body),
        type: String(type),
        confidence: Number(confidence),
        created_at: String(timestamp),
        updated_at: String(timestamp),
        origin_session_id: originSessionId === null ? null : String(originSessionId),
        deleted_at: null,
        forget_reason: null
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE") && text.includes("SET title")) {
      const [namespace, name, title, description, body, type, confidence, timestamp] = values;
      const row = this.rows.find((candidate) => candidate.namespace === namespace && candidate.name === name);
      if (!row) return { rows: [], rowCount: 0 };
      row.title = String(title);
      row.description = String(description);
      row.body = String(body);
      row.type = String(type);
      row.confidence = Number(confidence);
      row.updated_at = String(timestamp);
      row.deleted_at = null;
      row.forget_reason = null;
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("UPDATE") && text.includes("SET deleted_at")) {
      const [namespace, name, timestamp, reason] = values;
      const row = this.rows.find((candidate) => candidate.namespace === namespace && candidate.name === name && candidate.deleted_at === null);
      if (!row) return { rows: [], rowCount: 0 };
      row.deleted_at = String(timestamp);
      row.forget_reason = String(reason);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test fake: ${text}`);
  }
}

function makeStore(env: Record<string, string> = { GURU_MEMORY_DATABASE_URL: "postgres://test@example.test/guru" }) {
  const pool = new FakePostgresPool();
  const store = createPostgresMemoryStore({
    config: MemoryPostgresConfigSchema.parse({}),
    env,
    sessionId: "test-session",
    now: () => new Date("2026-07-12T00:00:00.000Z"),
    poolFactory: () => pool
  });
  return { store, pool };
}

describe("PostgreSQL memory store", () => {
  it("reports a missing connection environment variable without exposing a value", async () => {
    const { store } = makeStore({});

    const status = await store.status();

    expect(status).toMatchObject({ provider: "postgres", status: "missing-env", missingEnvNames: ["GURU_MEMORY_DATABASE_URL"] });
    expect(JSON.stringify(status)).not.toContain("postgres://");
    expect(
      await store.remember({ title: "No fallback", description: "PostgreSQL failure must not write Markdown", body: "This write is refused.", type: "project", edit: "replace", confidence: 1 })
    ).toMatchObject({ status: "blocked", blockers: ["postgres-unavailable"] });
  });

  it("creates, updates, searches, gets, and soft-deletes fact memory through parameterized queries", async () => {
    const { store, pool } = makeStore();

    expect((await store.status()).status).toBe("ready");
    const created = await store.remember({
      title: "Postgres memory keeps durable facts",
      description: "Guru can store facts in a configured PostgreSQL database",
      body: "The configured schema is owned by Guru.",
      type: "project",
      edit: "replace",
      confidence: 1
    });
    expect(created).toMatchObject({ status: "created", name: "postgres-memory-keeps-durable-facts" });

    const found = await store.get("postgres-memory-keeps-durable-facts");
    expect(found).toMatchObject({ found: true, body: "The configured schema is owned by Guru." });

    const updated = await store.remember({
      name: "postgres-memory-keeps-durable-facts",
      title: "Postgres memory keeps durable facts",
      description: "Updated description",
      body: "A second verified detail.",
      type: "project",
      edit: "append",
      confidence: 0.9
    });
    expect(updated.status).toBe("updated");
    expect((await store.get("postgres-memory-keeps-durable-facts")).body).toContain("A second verified detail.");

    const search = await store.search({ terms: "Postgres durable", limit: 6 });
    expect(search.hits[0]).toMatchObject({ name: "postgres-memory-keeps-durable-facts" });

    const forgotten = await store.forget({ name: "postgres-memory-keeps-durable-facts", reason: "superseded" });
    expect(forgotten.status).toBe("forgotten");
    expect((await store.get("postgres-memory-keeps-durable-facts")).found).toBe(false);

    const insert = pool.calls.find((call) => call.text.startsWith("INSERT INTO"));
    expect(insert?.text).toContain("$1");
    expect(insert?.text).not.toContain("Postgres memory keeps durable facts");
  });
});
