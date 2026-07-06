import {
  createCreateOperationalBacklogItemTool,
  createCreateOperationalImplementationTool,
  createInMemoryOperationalStore,
  createListOperationalBacklogItemsTool,
  createListOperationalStateSnapshotsTool,
  createUpsertOperationalDecisionTool,
  createWriteOperationalStateSnapshotTool
} from "../../src/index.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

describe("expanded operational store tools", () => {
  it("should dry-run state writes by default without mutating the store", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createRegistry(store);

    const write = await executeRegisteredTool(registry, "operational.state.write", {
      projectSlug: "guruharness",
      kind: "current",
      title: "Dry-run state",
      body: "This should not be stored."
    });
    const list = await executeRegisteredTool(registry, "operational.state.list", {
      projectSlug: "guruharness",
      kinds: ["current"]
    });

    expect(write.output).toMatchObject({ dryRun: true, snapshot: null, blockers: [] });
    expect(list.output).toMatchObject({ snapshots: [] });
  });

  it("should write and list state snapshots when dryRun is false", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createRegistry(store);

    const write = await executeRegisteredTool(registry, "operational.state.write", {
      projectSlug: "guruharness",
      kind: "note",
      title: "Live state",
      body: "Stored note.",
      metadata: { task: "github-and-operational-tool-expansion" },
      dryRun: false
    });
    const list = await executeRegisteredTool(registry, "operational.state.list", {
      projectSlug: "guruharness",
      kinds: ["note"],
      metadata: { task: "github-and-operational-tool-expansion" }
    });

    expect(write.output).toMatchObject({ dryRun: false, snapshot: expect.objectContaining({ title: "Live state" }) });
    expect(list.output).toMatchObject({ snapshots: [expect.objectContaining({ title: "Live state" })] });
  });

  it("should upsert decisions with dry-run by default and live apply on request", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createRegistry(store);

    const dryRun = await executeRegisteredTool(registry, "operational.decision.upsert", {
      projectSlug: "guruharness",
      decisionKey: "dry-run-only",
      title: "Dry run decision",
      context: "Testing dry-run behavior.",
      decision: "Do not persist.",
      consequences: "No state changes."
    });
    const live = await executeRegisteredTool(registry, "operational.decision.upsert", {
      projectSlug: "guruharness",
      decisionKey: "live-decision",
      title: "Live decision",
      context: "Testing live behavior.",
      decision: "Persist this decision.",
      consequences: "Decision record exists.",
      dryRun: false
    });

    expect(dryRun.output).toMatchObject({ dryRun: true, decision: null });
    expect(live.output).toMatchObject({ dryRun: false, decision: expect.objectContaining({ decisionKey: "live-decision" }) });
  });

  it("should create and list backlog items", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createRegistry(store);

    const create = await executeRegisteredTool(registry, "operational.backlog.create", {
      projectSlug: "guruharness",
      title: "Follow-up tool polish",
      description: "Polish operational tools after first slice.",
      priority: "next",
      status: "ready",
      dryRun: false
    });
    const list = await executeRegisteredTool(registry, "operational.backlog.list", {
      projectSlug: "guruharness",
      statuses: ["ready"]
    });

    expect(create.output).toMatchObject({ item: expect.objectContaining({ title: "Follow-up tool polish" }) });
    expect(list.output).toMatchObject({ items: [expect.objectContaining({ title: "Follow-up tool polish" })] });
  });

  it("should create implementation status records", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createRegistry(store);

    const observation = await executeRegisteredTool(registry, "operational.implementation.create", {
      projectSlug: "guruharness",
      title: "GitHub operational tools",
      status: "in_review",
      branchName: "feat/github-operational-tools",
      summary: "Runtime helper tools are in review.",
      dryRun: false
    });

    expect(observation.output).toMatchObject({
      dryRun: false,
      implementation: expect.objectContaining({ title: "GitHub operational tools", status: "in_review" })
    });
  });

  it("should block secret-like operational content without leaking the secret", async () => {
    const store = createInMemoryOperationalStore();
    const registry = createRegistry(store);
    const secret = "sk_test_1234567890abcdefghijklmnop";

    const observation = await executeRegisteredTool(registry, "operational.state.write", {
      projectSlug: "guruharness",
      kind: "risk",
      title: "Secret risk",
      body: `token=${secret}`,
      dryRun: false
    });

    expect(observation.output).toMatchObject({ dryRun: false, snapshot: null });
    expect(JSON.stringify(observation.output)).toContain("stripe-secret-key");
    expect(JSON.stringify(observation.output)).not.toContain(secret);
  });
});

function createRegistry(store = createInMemoryOperationalStore()) {
  return createToolRegistry([
    createWriteOperationalStateSnapshotTool(store, { secretAllowList: [] }),
    createListOperationalStateSnapshotsTool(store),
    createUpsertOperationalDecisionTool(store, { secretAllowList: [] }),
    createCreateOperationalBacklogItemTool(store, { secretAllowList: [] }),
    createListOperationalBacklogItemsTool(store),
    createCreateOperationalImplementationTool(store, { secretAllowList: [] })
  ]);
}
