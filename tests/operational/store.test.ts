import {
  createInMemoryOperationalStore,
  createPostgresOperationalStore,
  type SqlClient,
  type SqlStatement,
  type TransactionalSqlClient
} from "../../src/operational/store.js";
import {
  createGetOperationalProjectTool,
  createRecordOperationalBlockerTool
} from "../../src/tools/builtins/operationalStoreTools.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

describe("createInMemoryOperationalStore", () => {
  it("should read the default GuruHarness project", async () => {
    const store = createInMemoryOperationalStore();

    const project = await store.getProjectBySlug("guruharness");

    expect(project).toMatchObject({ slug: "guruharness", status: "active" });
  });

  it("should upsert decisions by project and key", async () => {
    const store = createInMemoryOperationalStore();

    const firstDecision = await store.upsertDecision({
      projectSlug: "guruharness",
      decisionKey: "runtime-store",
      title: "Use runtime store",
      context: "Need durable state.",
      decision: "Use the operational store.",
      consequences: "Harness code can write records."
    });
    const secondDecision = await store.upsertDecision({
      projectSlug: "guruharness",
      decisionKey: "runtime-store",
      title: "Use runtime operational store",
      context: "Need durable state.",
      decision: "Use the operational store.",
      consequences: "Harness code can write records."
    });

    expect(secondDecision.id).toBe(firstDecision.id);
    expect(secondDecision.title).toBe("Use runtime operational store");
  });

  it("should write, list, and filter state snapshots", async () => {
    const store = createInMemoryOperationalStore();

    await store.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "current",
      title: "Runtime adapter active",
      body: "Operational store is writable.",
      metadata: { scope: "runtime", runId: "run-1" }
    });
    await store.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "note",
      title: "Other snapshot",
      body: "Different scope.",
      metadata: { scope: "other" }
    });
    await store.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "current",
      title: "Nested snapshot",
      body: "Nested metadata.",
      metadata: { scope: "runtime", nested: { status: "ok", tags: ["a", "b"] } }
    });
    const snapshots = await store.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["current"],
      metadata: { scope: "runtime", nested: { tags: ["b"] } }
    });
    const implementation = await store.createImplementation({
      projectSlug: "guruharness",
      title: "Runtime adapter",
      status: "in_review",
      branchName: "feat/runtime-adapter",
      summary: "Adapter implemented."
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ title: "Nested snapshot", metadata: { nested: { tags: ["a", "b"] } } });
    expect(implementation).toMatchObject({
      title: "Runtime adapter",
      status: "in_review",
      branchName: "feat/runtime-adapter",
      backlogItemId: null
    });
  });

  it("should record blockers as risk snapshots and blocked backlog items", async () => {
    const store = createInMemoryOperationalStore();

    const blocker = await store.recordBlocker({
      projectSlug: "guruharness",
      title: "Blocked by missing auth",
      body: "Runtime credentials are not configured.",
      metadata: { runId: "run-1" }
    });
    const backlogItems = await store.listBacklogItems({ projectSlug: "guruharness", statuses: ["blocked"] });

    expect(blocker.stateSnapshot).toMatchObject({ kind: "risk", title: "Blocked by missing auth" });
    expect(blocker.backlogItem).toMatchObject({ status: "blocked", title: "Blocked by missing auth" });
    expect(backlogItems).toHaveLength(1);
  });

  it("should preserve in-memory state snapshot insertion order and Postgres-style metadata containment", async () => {
    const store = createInMemoryOperationalStore();

    await store.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "note",
      title: "First runtime event",
      body: "First.",
      metadata: { scope: "runtime", nested: { status: "ok" }, tags: ["alpha", "beta"], primitive: 1 }
    });
    await store.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "note",
      title: "Second runtime event",
      body: "Second.",
      metadata: { scope: "runtime", nested: { status: "ok" }, tags: ["beta", "gamma"], primitive: 1 }
    });

    const snapshots = await store.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["note"],
      metadata: { nested: { status: "ok" }, tags: ["beta"], primitive: 1 }
    });

    expect(snapshots.map((snapshot) => snapshot.title)).toEqual(["First runtime event", "Second runtime event"]);
  });

  it("should list newest in-memory backlog items first", async () => {
    const store = createInMemoryOperationalStore();

    await store.createBacklogItem({ projectSlug: "guruharness", title: "First task" });
    await store.createBacklogItem({ projectSlug: "guruharness", title: "Second task" });

    const backlogItems = await store.listBacklogItems({ projectSlug: "guruharness", statuses: ["ready"] });

    expect(backlogItems.map((item) => item.title)).toEqual(["Second task", "First task"]);
  });

  it("should deep-clone metadata returned from the in-memory store", async () => {
    const store = createInMemoryOperationalStore();
    const firstProject = await store.getProjectBySlug("guruharness");

    if (!firstProject) {
      throw new Error("Expected default project to exist.");
    }

    firstProject.metadata.nested = { changed: true };
    const secondProject = await store.getProjectBySlug("guruharness");

    expect(secondProject?.metadata).toEqual({});
  });

  it("should reject writes for unknown projects", async () => {
    const store = createInMemoryOperationalStore();

    await expect(
      store.createBacklogItem({ projectSlug: "missing-project", title: "Task", description: "Task body" })
    ).rejects.toThrow("Operational project not found: missing-project");
  });
});

describe("createPostgresOperationalStore", () => {
  it("should execute parameterized project and decision upsert queries", async () => {
    const executedStatements: SqlStatement[] = [];
    const client = createFakeSqlClient(executedStatements, [
      [projectRow()],
      [
        {
          id: "decision-1",
          project_id: "project-1",
          decision_key: "runtime-store",
          title: "Use runtime store",
          status: "accepted",
          owner: "Matthew",
          context: "Need durable state.",
          decision: "Use the operational store.",
          consequences: "Harness code can write records.",
          metadata: { source: "test" }
        }
      ]
    ]);
    const store = createPostgresOperationalStore(client);

    const decision = await store.upsertDecision({
      projectSlug: "guruharness",
      decisionKey: "runtime-store",
      title: "Use runtime store",
      context: "Need durable state.",
      decision: "Use the operational store.",
      consequences: "Harness code can write records.",
      metadata: { source: "test" }
    });

    expect(decision).toMatchObject({ decisionKey: "runtime-store", projectId: "project-1" });
    expect(executedStatements).toHaveLength(2);
    expect(executedStatements[0]?.text).toContain("from harness.projects");
    expect(executedStatements[1]?.text).toContain("on conflict (project_id, decision_key) do update");
    expect(executedStatements[1]?.values).toContain(JSON.stringify({ source: "test" }));
  });

  it("should write, list, and parse state snapshot rows", async () => {
    const executedStatements: SqlStatement[] = [];
    const client = createFakeSqlClient(executedStatements, [
      [projectRow()],
      [
        {
          id: "snapshot-1",
          project_id: "project-1",
          kind: "current",
          title: "Runtime adapter active",
          body: "Operational store is writable.",
          source: "test",
          confidence: "0.95",
          metadata: { safe: true }
        }
      ],
      [projectRow()],
      [
        {
          id: "snapshot-1",
          project_id: "project-1",
          kind: "current",
          title: "Runtime adapter active",
          body: "Operational store is writable.",
          source: "test",
          confidence: "0.95",
          metadata: { safe: true }
        }
      ]
    ]);
    const store = createPostgresOperationalStore(client);

    const snapshot = await store.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "current",
      title: "Runtime adapter active",
      body: "Operational store is writable.",
      source: "test",
      confidence: 0.95,
      metadata: { safe: true }
    });
    const snapshots = await store.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["current"],
      source: "test",
      metadata: { safe: true }
    });

    expect(snapshot).toMatchObject({ id: "snapshot-1", confidence: 0.95, metadata: { safe: true } });
    expect(snapshots).toHaveLength(1);
    expect(executedStatements[1]?.text).toContain("insert into harness.state_snapshots");
    expect(executedStatements[1]?.values).toContain(JSON.stringify({ safe: true }));
    expect(executedStatements[3]?.text).toContain("metadata @> $4::jsonb");
    expect(executedStatements[3]?.text).toContain("order by created_at asc, id asc");
    expect(executedStatements[3]?.values).toEqual(["project-1", ["current"], "test", JSON.stringify({ safe: true })]);
  });

  it("should list backlog items using status filters", async () => {
    const executedStatements: SqlStatement[] = [];
    const client = createFakeSqlClient(executedStatements, [
      [projectRow()],
      [
        {
          id: "backlog-1",
          project_id: "project-1",
          title: "Build runtime adapter",
          description: "Read and write operations.",
          priority: "next",
          status: "ready",
          source: "test",
          metadata: {}
        }
      ]
    ]);
    const store = createPostgresOperationalStore(client);

    const backlogItems = await store.listBacklogItems({ projectSlug: "guruharness", statuses: ["ready"] });

    expect(backlogItems).toEqual([
      expect.objectContaining({ id: "backlog-1", title: "Build runtime adapter", status: "ready" })
    ]);
    expect(executedStatements[1]?.values).toEqual(["project-1", ["ready"]]);
  });

  it("should write and parse implementation rows", async () => {
    const executedStatements: SqlStatement[] = [];
    const client = createFakeSqlClient(executedStatements, [
      [projectRow()],
      [
        {
          id: "implementation-1",
          project_id: "project-1",
          backlog_item_id: null,
          title: "Runtime adapter",
          status: "in_review",
          branch_name: "feat/runtime-adapter",
          commit_sha: "abcdef1",
          pr_url: "https://github.com/AutomationsGuru/GuruHarness/pull/15",
          summary: "Adapter implemented.",
          metadata: {}
        }
      ]
    ]);
    const store = createPostgresOperationalStore(client);

    const implementation = await store.createImplementation({
      projectSlug: "guruharness",
      title: "Runtime adapter",
      status: "in_review",
      branchName: "feat/runtime-adapter",
      commitSha: "abcdef1",
      prUrl: "https://github.com/AutomationsGuru/GuruHarness/pull/15",
      summary: "Adapter implemented."
    });

    expect(implementation).toMatchObject({ id: "implementation-1", status: "in_review", commitSha: "abcdef1" });
    expect(executedStatements[1]?.text).toContain("insert into harness.implementations");
  });

  it("should wrap blocker recording in a transaction when the SQL client supports transactions", async () => {
    const executedStatements: SqlStatement[] = [];
    const client = createFakeTransactionalSqlClient(executedStatements, [
      [projectRow()],
      [
        {
          id: "snapshot-1",
          project_id: "project-1",
          kind: "risk",
          title: "Blocked",
          body: "Need dependency.",
          source: "runtime",
          confidence: 1,
          metadata: {}
        }
      ],
      [projectRow()],
      [
        {
          id: "backlog-1",
          project_id: "project-1",
          title: "Blocked",
          description: "Need dependency.",
          priority: "next",
          status: "blocked",
          source: "runtime",
          metadata: {}
        }
      ]
    ]);
    const store = createPostgresOperationalStore(client);

    const blocker = await store.recordBlocker({ projectSlug: "guruharness", title: "Blocked", body: "Need dependency." });

    expect(blocker.backlogItem).toMatchObject({ id: "backlog-1", status: "blocked" });
    expect(client.transactionCount).toBe(1);
  });

  it("should stop blocker recording before backlog insert when the snapshot write fails", async () => {
    const executedStatements: SqlStatement[] = [];
    const client = createFakeSqlClient(executedStatements, [[projectRow()], []]);
    const store = createPostgresOperationalStore(client);

    await expect(
      store.recordBlocker({ projectSlug: "guruharness", title: "Blocked", body: "Snapshot insert failed." })
    ).rejects.toThrow("No state snapshot row returned from operational store.");

    expect(executedStatements).toHaveLength(2);
    expect(executedStatements[1]?.text).toContain("insert into harness.state_snapshots");
  });
});

describe("operational store tools", () => {
  it("should expose project lookup through the tool registry", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createToolRegistry([createGetOperationalProjectTool(store)]);

    const observation = await executeRegisteredTool(registry, "operational.project.get", { projectSlug: "guruharness" });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({ project: { slug: "guruharness" } });
  });

  it("should expose blocker recording through the tool registry", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createToolRegistry([createRecordOperationalBlockerTool(store)]);

    const observation = await executeRegisteredTool(registry, "operational.blocker.record", {
      projectSlug: "guruharness",
      title: "Blocked by dependency",
      body: "Need upstream dependency."
    });

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toMatchObject({
      stateSnapshot: { kind: "risk", title: "Blocked by dependency" },
      backlogItem: { status: "blocked", title: "Blocked by dependency" }
    });
  });
});

function createFakeSqlClient(executedStatements: SqlStatement[], rowBatches: Array<Array<Record<string, unknown>>>): SqlClient {
  return {
    async query(statement) {
      executedStatements.push(statement);

      return { rows: rowBatches.shift() ?? [] };
    }
  };
}

function createFakeTransactionalSqlClient(
  executedStatements: SqlStatement[],
  rowBatches: Array<Array<Record<string, unknown>>>
): TransactionalSqlClient & { transactionCount: number } {
  return {
    transactionCount: 0,
    async query(statement) {
      executedStatements.push(statement);

      return { rows: rowBatches.shift() ?? [] };
    },
    async transaction(callback) {
      this.transactionCount += 1;

      return callback(this);
    }
  };
}

function projectRow(): Record<string, unknown> {
  return {
    id: "project-1",
    slug: "guruharness",
    name: "GuruHarness",
    purpose: "Harness runtime state.",
    status: "active",
    metadata: {}
  };
}
