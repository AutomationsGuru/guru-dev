import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryConfigSchema } from "../../src/config/schema.js";
import { LearningSchema, learningId } from "../../src/garage/flywheel.js";
import { storeLearning } from "../../src/garage/flywheelStore.js";
import {
  createMemorySessionService,
  describeMemoryStorage,
  formatMemoryBriefingStatus,
  refreshMemorySystemHead
} from "../../src/guru/memorySessionService.js";
import { createMarkdownMemoryStore, type MemoryFactStore } from "../../src/memory/provider.js";
import { createFileMemoryStore, type MemoryFactEntry } from "../../src/memory/store.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "guru-memory-session-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function entry(name: string, title: string, description: string): MemoryFactEntry {
  const stamp = "2026-07-14T00:00:00.000Z";
  return { fact: { name, title, description, type: "project", createdAt: stamp, updatedAt: stamp, confidence: 1 }, body: description };
}

function fakeStore(provider: "markdown" | "postgres", list: () => Promise<readonly MemoryFactEntry[]>): MemoryFactStore {
  return {
    provider,
    directory: provider === "postgres" ? "postgres:guru_memory.facts/global" : "/memory",
    async status() {
      return { provider, status: "ready", summary: `${provider} ready`, missingEnvNames: [], location: this.directory };
    },
    async remember() {
      return { status: "created", name: "saved-fact", summary: "Remembered [[saved-fact]].", blockers: [] };
    },
    async get(name) {
      return { found: false, links: [], backlinks: [], danglingLinks: [], summary: `No memory fact named '${name}'.` };
    },
    async search() {
      return { hits: [], summary: "No memory facts matched." };
    },
    async forget() {
      return { status: "blocked", summary: "not found", blockers: ["not-found"] };
    },
    list,
    async doctor() {
      return { directory: this.directory, factCount: 0, corruptSkipped: [], orphanTempsRemoved: 0, trashRemoved: 0, danglingLinks: [], indexRebuilt: false, summary: `${provider} ready` };
    }
  };
}

describe("memory session service", () => {
  it("keeps healthy PostgreSQL facts and boot briefing when the local learning store fails", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "local") });
    base.remember({ name: "local-only", title: "Local only", description: "must not become fallback", body: "local", type: "project", edit: "replace", confidence: 1 });
    const postgres = fakeStore("postgres", async () => [entry("database-fact", "Database fact", "canonical database context")]);
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: postgres,
      memoryConfig: MemoryConfigSchema.parse({ storage: { provider: "postgres" } })
    });
    vi.spyOn(base, "list").mockImplementation(() => {
      throw new Error("local learning store unavailable");
    });

    await service.refresh();
    const briefing = service.briefingLines({
      status: "ready",
      summary: "Honcho context is available."
    });

    expect(service.contextBlock).toContain("Database fact");
    expect(service.contextBlock).not.toContain("Local only");
    expect(service.canonicalFactCount).toBe(1);
    expect(briefing).toEqual([
      "PostgreSQL fact memory · honcho ready · 0 learning(s) injected (decay-ranked, with provenance)",
      "honcho: Honcho context is available."
    ]);
  });

  it("recalls healthy PostgreSQL facts when the local learning store fails", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "local") });
    base.remember({ name: "local-only", title: "Local only", description: "must not become fallback", body: "local", type: "project", edit: "replace", confidence: 1 });
    const postgres = fakeStore("postgres", async () => [entry("database-fact", "Database fact", "canonical database context")]);
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: postgres,
      memoryConfig: MemoryConfigSchema.parse({ storage: { provider: "postgres" } })
    });
    vi.spyOn(base, "list").mockImplementation(() => {
      throw new Error("local learning store unavailable");
    });

    const recalled = await service.runCommand("/recall", ["database", "context"]);
    const output = recalled.lines.map(({ text }) => text).join("\n");

    expect(output).toContain("Database fact — canonical database context");
    expect(output).not.toContain("Local only");
  });

  it("selects Markdown space and role stores through the fact-store facade", async () => {
    const root = freshRoot();
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const global = createFileMemoryStore({ directory: join(home, "global") });
    const service = createMemorySessionService({
      baseStore: global,
      configuredStore: createMarkdownMemoryStore(global),
      memoryConfig: MemoryConfigSchema.parse({}),
      scopedMemoryOptions: { home }
    });

    service.bindRepoRoot(repo);
    service.bindRole("finance");
    const space = await service.runCommand("/remember", ["space", "OAuth login belongs to this project."]);
    const role = await service.runCommand("/remember", ["role", "Ledger totals need validation."]);
    await service.refresh({ query: "oauth login" });

    expect(space.lines.at(-1)).toMatchObject({ tone: "success" });
    expect(role.lines.at(-1)).toMatchObject({ tone: "success" });
    expect(global.list()).toHaveLength(0);
    expect(service.localStoreFor("space")?.list()).toHaveLength(1);
    expect(service.localStoreFor("role")?.list()).toHaveLength(1);
    expect(service.contextBlock).toContain("OAuth login belongs to this project.");
    expect(service.contextBlock).toContain("·space");
    expect(service.contextBlock.indexOf("OAuth login")).toBeLessThan(service.contextBlock.indexOf("Ledger totals"));
  });

  it("keeps last-good Markdown context but clears failed PostgreSQL context without fallback", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "local") });
    base.remember({ name: "markdown-fallback", title: "Markdown fallback", description: "must stay out", body: "local", type: "project", edit: "replace", confidence: 1 });

    let markdownFails = false;
    const markdown = fakeStore("markdown", async () => {
      if (markdownFails) throw new Error("markdown temporarily unavailable");
      return [entry("last-good", "Last good fact", "keep this context")];
    });
    const markdownService = createMemorySessionService({ baseStore: base, configuredStore: markdown, memoryConfig: MemoryConfigSchema.parse({}) });
    await markdownService.refresh();
    markdownFails = true;
    await markdownService.refresh();

    let postgresFails = false;
    const postgres = fakeStore("postgres", async () => {
      if (postgresFails) throw new Error("postgres offline");
      return [entry("postgres-fact", "PostgreSQL fact", "canonical database context")];
    });
    const postgresService = createMemorySessionService({
      baseStore: base,
      configuredStore: postgres,
      memoryConfig: MemoryConfigSchema.parse({ storage: { provider: "postgres" } })
    });
    await postgresService.refresh();
    expect(postgresService.contextBlock).toContain("PostgreSQL fact");
    postgresFails = true;
    await postgresService.refresh();

    expect(markdownService.contextBlock).toContain("Last good fact");
    expect(postgresService.contextBlock).toBe("");
    expect(postgresService.contextBlock).not.toContain("Markdown fallback");
  });

  it("runs explicit idempotent migration without deleting Markdown or copying operational facts", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    for (const [name, type] of [
      ["project-fact", "project"],
      ["learning-fact", "learning"],
      ["loadout-fact", "loadout"],
      ["path-outcome-fact", "path-outcome"]
    ] as const) {
      base.remember({ name, title: name, description: `${type} source`, body: `${type} body`, type, edit: "replace", confidence: 1 });
    }
    const postgresEntries: MemoryFactEntry[] = [];
    const postgres: MemoryFactStore = {
      ...fakeStore("postgres", async () => postgresEntries),
      async remember(input) {
        const name = input.name ?? "generated-fact";
        const existing = postgresEntries.find((candidate) => candidate.fact.name === name);
        const stamp = "2026-07-14T00:00:00.000Z";
        const next = { fact: { name, title: input.title, description: input.description, type: input.type, createdAt: existing?.fact.createdAt ?? stamp, updatedAt: stamp, confidence: input.confidence }, body: input.body } satisfies MemoryFactEntry;
        if (existing) {
          postgresEntries[postgresEntries.indexOf(existing)] = next;
          return { status: "updated", name, summary: `Updated [[${name}]] in place (replace).`, blockers: [] };
        }
        postgresEntries.push(next);
        return { status: "created", name, summary: `Remembered [[${name}]].`, blockers: [] };
      }
    };
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: postgres,
      memoryConfig: MemoryConfigSchema.parse({ storage: { provider: "postgres" } })
    });

    const first = await service.runCommand("/memory", ["migrate"]);
    const second = await service.runCommand("/memory", ["migrate"]);

    expect(first.lines.at(-1)?.text).toContain("Migrated 1 Markdown fact(s), updated 0; 0 blocked");
    expect(second.lines.at(-1)?.text).toContain("Migrated 0 Markdown fact(s), updated 1; 0 blocked");
    expect(postgresEntries.map(({ fact }) => fact.name)).toEqual(["project-fact"]);
    expect(base.list()).toHaveLength(4);
  });

  it("adds Honcho context once and preserves the real or test status summary unchanged", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    base.remember({ name: "canonical-fact", title: "Canonical fact", description: "deterministic source", body: "body", type: "project", edit: "replace", confidence: 1 });
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: createMarkdownMemoryStore(base),
      memoryConfig: MemoryConfigSchema.parse({ honcho: { enabled: true, syncOnTurn: true } })
    });
    const executeTool = vi.fn(async (_sessionId: string, toolId: string) => {
      const output = toolId === "honcho_context"
        ? { status: "succeeded", snapshot: "derived Honcho snapshot", summary: "Built Honcho test context snapshot from 1 item(s)." }
        : { status: "ready", writeEnabled: true, missingEnvNames: [], summary: "Honcho test double is write-enabled." };
      return { toolId, status: "succeeded" as const, startedAt: "now", endedAt: "now", durationMs: 0, output };
    });
    const toolContext = { sessionId: "session-1", runtime: { executeTool } };

    await service.refresh({ toolContext });
    await service.refresh({ toolContext });
    const status = await service.honchoStatus(toolContext);

    expect(service.contextBlock).toContain("Canonical fact");
    expect(service.contextBlock.match(/## Honcho memory context/gu)).toHaveLength(1);
    expect(service.contextBlock).toContain("derived Honcho snapshot");
    expect(status.summary).toBe("Honcho test double is write-enabled.");
  });

  it("preserves canonical memory when the Honcho context promise rejects", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    base.remember({ name: "canonical-fact", title: "Canonical fact", description: "survives rejected Honcho", body: "body", type: "project", edit: "replace", confidence: 1 });
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: createMarkdownMemoryStore(base),
      memoryConfig: MemoryConfigSchema.parse({ honcho: { enabled: true, syncOnTurn: true } })
    });
    const executeTool = vi.fn(() => Promise.reject(new Error("Honcho rejected")));

    await service.refresh({ toolContext: { sessionId: "session-1", runtime: { executeTool } } });

    expect(service.contextBlock).toContain("Canonical fact");
    expect(service.contextBlock).not.toContain("Honcho memory context");
  });

  it("keeps canonical memory after the bounded Honcho refresh budget expires", async () => {
    vi.useFakeTimers();
    try {
      const root = freshRoot();
      const base = createFileMemoryStore({ directory: join(root, "markdown") });
      base.remember({ name: "canonical-fact", title: "Canonical fact", description: "survives Honcho timeout", body: "body", type: "project", edit: "replace", confidence: 1 });
      const service = createMemorySessionService({
        baseStore: base,
        configuredStore: createMarkdownMemoryStore(base),
        memoryConfig: MemoryConfigSchema.parse({ honcho: { enabled: true, syncOnTurn: true } }),
        honchoTimeoutMs: 5
      });
      const executeTool = vi.fn(() => new Promise<never>(() => {}));

      const refresh = service.refresh({ toolContext: { sessionId: "session-1", runtime: { executeTool } } });
      await vi.advanceTimersByTimeAsync(5);
      await refresh;

      expect(service.contextBlock).toContain("Canonical fact");
      expect(service.contextBlock).not.toContain("Honcho memory context");
    } finally {
      vi.useRealTimers();
    }
  });

  it("backgrounds completed-turn Honcho logging without holding the caller", () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: createMarkdownMemoryStore(base),
      memoryConfig: MemoryConfigSchema.parse({ honcho: { enabled: true, syncOnTurn: true } })
    });
    const executeTool = vi.fn(() => new Promise<never>(() => {}));
    const toolContext = { sessionId: "session-1", runtime: { executeTool } };

    expect(service.recordTurn(toolContext, "operator summary", "assistant summary")).toBeUndefined();
    expect(executeTool).toHaveBeenCalledWith("session-1", "honcho_log_turn", {
      userSummary: "operator summary",
      assistantSummary: "assistant summary",
      writeEnabled: true,
      userApproved: true
    });
  });

  it("swallows a rejected background Honcho turn without throwing", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: createMarkdownMemoryStore(base),
      memoryConfig: MemoryConfigSchema.parse({ honcho: { enabled: true, syncOnTurn: true } })
    });
    const executeTool = vi.fn(() => Promise.reject(new Error("Honcho log rejected")));

    expect(service.recordTurn({ sessionId: "session-1", runtime: { executeTool } }, "operator", "assistant")).toBeUndefined();
    await Promise.resolve();
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it("recalls scoped facts and local learnings through one command path", async () => {
    const root = freshRoot();
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const base = createFileMemoryStore({ directory: join(home, "global") });
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: createMarkdownMemoryStore(base),
      memoryConfig: MemoryConfigSchema.parse({}),
      scopedMemoryOptions: { home }
    });
    service.bindRepoRoot(repo);
    service.bindRole("auth");
    await service.runCommand("/remember", ["space", "OAuth login uses the project callback."]);
    const statement = "OAuth checks should validate the callback state before exchange.";
    storeLearning(service.localStoreFor("role")!, LearningSchema.parse({
      id: learningId("role", "L1", statement),
      scope: "role",
      roleSlug: "auth",
      level: "L1",
      statement,
      subject: "oauth-callback",
      createdAt: "2026-07-14T00:00:00.000Z"
    }));

    const recalled = await service.runCommand("/recall", ["oauth", "callback"]);
    const output = recalled.lines.map(({ text }) => text).join("\n");

    expect(output).toContain("recall — 2 related");
    expect(output).toContain("fact ·space");
    expect(output).toContain("learning ·role");
    expect(output).toContain("OAuth checks should validate");
    expect(recalled.lines[0]?.segments?.map(({ tone }) => tone)).toEqual(["heading", "muted"]);
    expect(recalled.lines[1]?.segments?.map(({ tone }) => tone)).toEqual(["plain", "info", "muted", "plain"]);
  });

  it("awaits a role-scoped refresh before replacing the system head", async () => {
    const root = freshRoot();
    const home = join(root, "home");
    const base = createFileMemoryStore({ directory: join(home, "global") });
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: createMarkdownMemoryStore(base),
      memoryConfig: MemoryConfigSchema.parse({}),
      scopedMemoryOptions: { home }
    });
    service.bindRole("finance");
    await service.runCommand("/remember", ["role", "Ledger totals need validation."]);
    const history = [{ role: "system" as const, content: "OLD" }, { role: "user" as const, content: "keep" }];

    await refreshMemorySystemHead(service, history, "BASE");

    expect(history[0]?.content).toContain("Ledger totals need validation.");
    expect(history[0]?.content).toContain("·role");
    expect(history[1]).toEqual({ role: "user", content: "keep" });
  });

  it("runs the configured fact store doctor and refreshes the injected context", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    base.remember({ name: "doctor-fact", title: "Doctor fact", description: "survives repair", body: "body", type: "project", edit: "replace", confidence: 1 });
    const service = createMemorySessionService({ baseStore: base, configuredStore: createMarkdownMemoryStore(base), memoryConfig: MemoryConfigSchema.parse({}) });

    const result = await service.runCommand("/memory", ["doctor"]);

    expect(result.contextChanged).toBe(true);
    expect(result.lines[0]).toMatchObject({ tone: "success" });
    expect(result.lines[0]?.text).toContain("Index rebuilt");
    expect(service.contextBlock).toContain("Doctor fact");
  });

  it("leaves the injected context unchanged when a remember write is blocked", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    const blockedStore: MemoryFactStore = {
      ...fakeStore("markdown", async () => [entry("existing-fact", "Existing fact", "keep this context")]),
      async remember() {
        return { status: "blocked", name: "", summary: "Remember was blocked.", blockers: ["validation-failed"] };
      }
    };
    const service = createMemorySessionService({ baseStore: base, configuredStore: blockedStore, memoryConfig: MemoryConfigSchema.parse({}) });
    await service.refresh();
    const before = service.contextBlock;

    const result = await service.runCommand("/remember", ["replacement fact"]);

    expect(result.contextChanged).toBe(false);
    expect(result.lines).toContainEqual({ tone: "warning", text: "Remember was blocked." });
    expect(service.contextBlock).toBe(before);
  });

  it("renders PostgreSQL status without fallback and keeps the Honcho adapter summary honest", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    base.remember({ name: "local-only", title: "Local only", description: "must not appear", body: "body", type: "project", edit: "replace", confidence: 1 });
    const postgres = fakeStore("postgres", async () => [entry("database-fact", "Database fact", "canonical")]);
    const service = createMemorySessionService({
      baseStore: base,
      configuredStore: postgres,
      memoryConfig: MemoryConfigSchema.parse({ storage: { provider: "postgres" }, honcho: { enabled: true } })
    });
    const executeTool = vi.fn(async (_sessionId: string, toolId: string) => ({
      toolId,
      status: "succeeded" as const,
      startedAt: "now",
      endedAt: "now",
      durationMs: 0,
      output: { status: "ready", writeEnabled: true, missingEnvNames: [], summary: "Honcho test double is write-enabled." }
    }));

    const result = await service.runCommand("/memory", [], { sessionId: "session-1", runtime: { executeTool } });
    const output = result.lines.map(({ text }) => text).join("\n");

    expect(output).toContain("memory — 1 PostgreSQL fact(s)");
    expect(output).toContain("database-fact");
    expect(output).not.toContain("Local only");
    expect(output).toContain("Honcho test double is write-enabled.");
  });

  it("preserves Markdown status order and presentation-neutral row styling", async () => {
    const root = freshRoot();
    const base = createFileMemoryStore({ directory: join(root, "markdown") });
    base.remember({ name: "project-fact", title: "Project fact", description: "visible", body: "body", type: "project", edit: "replace", confidence: 1 });
    const service = createMemorySessionService({ baseStore: base, configuredStore: createMarkdownMemoryStore(base), memoryConfig: MemoryConfigSchema.parse({}) });

    const result = await service.runCommand("/memory", []);
    const texts = result.lines.map(({ text }) => text);
    const indexOf = (fragment: string) => texts.findIndex((line) => line.includes(fragment));
    const factRow = result.lines.find(({ text }) => text.includes("project-fact"));

    expect(indexOf("memory —")).toBeLessThan(indexOf("global"));
    expect(indexOf("global")).toBeLessThan(indexOf("project-fact"));
    expect(indexOf("project-fact")).toBeLessThan(indexOf("Obsidian-compatible"));
    expect(indexOf("Obsidian-compatible")).toBeLessThan(indexOf("storage"));
    expect(indexOf("storage")).toBeLessThan(indexOf("honcho"));
    expect(factRow?.segments?.map(({ tone }) => tone)).toEqual(["plain", "info", "muted"]);
  });

  it("describes one supplied storage snapshot without provider logic in guru", () => {
    const markdown = MemoryConfigSchema.parse({}).storage;
    const postgres = MemoryConfigSchema.parse({ storage: { provider: "postgres" } }).storage;

    expect(describeMemoryStorage(markdown)).toBe("markdown (Markdown vault + MEMORY.md index)");
    expect(describeMemoryStorage(postgres)).toContain(`postgres (${postgres.postgres.connectionStringEnvVar}; ${postgres.postgres.schema}.${postgres.postgres.table})`);
  });

  it("keeps the injected-learning count on the short boot line before the Honcho summary", () => {
    expect(formatMemoryBriefingStatus("PostgreSQL", { status: "ready", summary: "A very long Honcho status summary that must not clip the important count." }, 3)).toEqual([
      "PostgreSQL fact memory · honcho ready · 3 learning(s) injected (decay-ranked, with provenance)",
      "honcho: A very long Honcho status summary that must not clip the important count."
    ]);
  });
});
