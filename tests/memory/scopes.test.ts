import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore } from "../../src/memory/store.js";
import { createScopedMemory, resolveScopeDirectory, type MemoryScope } from "../../src/memory/scopes.js";
import { mergeScopedBootInjection } from "../../src/memory/inject.js";
import { LearningSchema, learningId, type Learning } from "../../src/garage/flywheel.js";
import { migrateRoleLearnings, storeLearning, loadLearnings } from "../../src/garage/flywheelStore.js";

let n = 0;
const roots: string[] = [];
function freshRoot(): string {
  const root = join(tmpdir(), `guru-scopes-${process.pid}-${n++}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scoped organ rooted at a temp HOME + repoRoot (no real ~/.guruharness touched). */
function scoped(home: string, repoRoot?: string) {
  const global = createFileMemoryStore({ directory: join(home, "global-mem"), now: () => new Date(Date.UTC(2026, 6, 5)) });
  return {
    global,
    mem: createScopedMemory(global, { home, now: () => new Date(Date.UTC(2026, 6, 5)), ...(repoRoot ? { repoRoot } : {}) })
  };
}

function learning(over: Partial<Learning> & { statement: string; subject: string }): Learning {
  return LearningSchema.parse({
    id: over.id ?? learningId(over.scope ?? "role", over.level ?? "L1", over.statement),
    scope: "role",
    level: "L1",
    createdAt: "2026-07-05T00:00:00.000Z",
    ...over
  });
}

describe("resolveScopeDirectory — the three namespaces (§7)", () => {
  it("global is always addressable; space needs a repo; role needs a slug", () => {
    const ctx = { home: "/h", repoRoot: "/repo", roleSlug: "finance" };
    expect(resolveScopeDirectory("global", ctx)).toBe(join("/h", ".guruharness", "memory"));
    expect(resolveScopeDirectory("space", ctx)).toBe(join("/repo", ".guru", "memory"));
    expect(resolveScopeDirectory("role", ctx)).toBe(join("/h", ".guruharness", "roles", "finance", "memory"));
  });

  it("space is null without a repo, role is null without a slug", () => {
    expect(resolveScopeDirectory("space", { home: "/h" })).toBeNull();
    expect(resolveScopeDirectory("role", { home: "/h", repoRoot: "/repo" })).toBeNull();
    expect(resolveScopeDirectory("global", {})).toContain(join(".guruharness", "memory"));
  });
});

describe("createScopedMemory — active scopes track the bound context", () => {
  it("only global is active until a repo / suit is bound; then space / role join", () => {
    const home = freshRoot();
    const { mem } = scoped(home);
    expect(mem.activeStores().map((s) => s.scope)).toEqual(["global"]);
    expect(mem.space()).toBeNull();
    expect(mem.role()).toBeNull();

    mem.setRepoRoot(join(freshRoot(), "proj"));
    expect(mem.activeStores().map((s) => s.scope)).toEqual(["global", "space"]);

    mem.setRole("finance-recon");
    expect(mem.activeStores().map((s) => s.scope)).toEqual(["global", "space", "role"]);

    // Clearing the suit drops the role scope again (park / off).
    mem.setRole(null);
    expect(mem.activeStores().map((s) => s.scope)).toEqual(["global", "space"]);
  });

  it("storeFor returns distinct physical directories per scope, memoized per key", () => {
    const home = freshRoot();
    const repoRoot = join(freshRoot(), "proj");
    const { global, mem } = scoped(home, repoRoot);
    mem.setRole("docs");
    const dirs = new Set(
      (["global", "space", "role"] as MemoryScope[]).map((scope) => mem.storeFor(scope)?.directory)
    );
    expect(dirs.size).toBe(3); // three different directories
    expect(mem.storeFor("global")).toBe(global); // global is the passed-in store
    expect(mem.storeFor("space")).toBe(mem.storeFor("space")); // memoized (same instance)
  });

  it("a written fact lands in ITS scope's directory, not global", () => {
    const home = freshRoot();
    const repoRoot = join(freshRoot(), "proj");
    const { global, mem } = scoped(home, repoRoot);
    const space = mem.storeFor("space");
    space?.remember({ title: "Space fact", description: "belongs to this repo", body: "b", type: "project", edit: "replace", confidence: 1 });
    expect(space?.list()).toHaveLength(1);
    expect(global.list()).toHaveLength(0); // did NOT leak into global
  });
});

describe("mergeScopedBootInjection — merge + dedup across scopes (§7)", () => {
  it("unions facts from every active scope and tags the non-global ones", () => {
    const home = freshRoot();
    const repoRoot = join(freshRoot(), "proj");
    const { mem } = scoped(home, repoRoot);
    mem.storeFor("global")?.remember({ name: "global-fact", title: "Global fact", description: "the floor", body: "b", type: "project", edit: "replace", confidence: 1 });
    mem.storeFor("space")?.remember({ name: "space-fact", title: "Space fact", description: "this repo", body: "b", type: "project", edit: "replace", confidence: 1 });
    const block = mergeScopedBootInjection(mem.activeStores(), { now: () => new Date(Date.UTC(2026, 6, 5)) }).block;
    expect(block).toContain("[Global fact]"); // present
    expect(block).toContain("this repo  ·space"); // tagged with its scope
    expect(block).not.toContain("the floor  ·"); // global carries no tag
  });

  it("MOST-SPECIFIC-WINS: a role fact shadows a same-named global fact", () => {
    const home = freshRoot();
    const { mem } = scoped(home);
    mem.setRole("finance");
    mem.storeFor("global")?.remember({ name: "policy", title: "Global policy", description: "generic", body: "b", type: "project", edit: "replace", confidence: 1 });
    mem.storeFor("role")?.remember({ name: "policy", title: "Role policy", description: "finance-specific", body: "b", type: "project", edit: "replace", confidence: 1 });
    const block = mergeScopedBootInjection(mem.activeStores(), { now: () => new Date(Date.UTC(2026, 6, 5)) }).block;
    expect(block).toContain("finance-specific  ·role"); // the specific one wins
    expect(block).not.toContain("Global policy"); // shadowed by name
  });

  it("ranks learnings from all scopes together and tags non-global ones", () => {
    const home = freshRoot();
    const { mem } = scoped(home);
    mem.setRole("finance");
    storeLearning(mem.storeFor("role")!, learning({ statement: "Role-scoped know-how for finance.", subject: "finance", scope: "role", roleSlug: "finance" }));
    storeLearning(mem.storeFor("global")!, learning({ statement: "A global learning everyone shares.", subject: "shared", scope: "global", id: learningId("global", "L1", "A global learning everyone shares.") }));
    const injection = mergeScopedBootInjection(mem.activeStores(), { now: () => new Date(Date.UTC(2026, 6, 5)) });
    expect(injection.block).toContain("Role-scoped know-how for finance.  ·role");
    expect(injection.block).toContain("A global learning everyone shares."); // global untagged
    expect(injection.injectedLearningIds).toHaveLength(2);
  });

  it("SMART CONNECTIONS: a query ranks the RELEVANT fact above a newer irrelevant one (§7)", () => {
    const home = freshRoot();
    const { mem } = scoped(home);
    const g = mem.storeFor("global")!;
    g.remember({ name: "auth-flow", title: "Auth flow", description: "oauth token validation and login handshake", body: "b", type: "project", edit: "replace", confidence: 1 });
    g.remember({ name: "ledger-nightly", title: "Ledger job", description: "reconcile the finance ledger nightly", body: "b", type: "project", edit: "replace", confidence: 1 });
    const now = () => new Date(Date.UTC(2026, 6, 5));
    // ledger-nightly was written LAST → recency puts it first with no query.
    const recency = mergeScopedBootInjection(mem.activeStores(), { now }).block;
    expect(recency.indexOf("Ledger job")).toBeLessThan(recency.indexOf("Auth flow"));
    // WITH an auth-related query, the older auth fact surfaces FIRST — relevance beats recency.
    const relevant = mergeScopedBootInjection(mem.activeStores(), { query: "oauth login token", now }).block;
    expect(relevant.indexOf("Auth flow")).toBeLessThan(relevant.indexOf("Ledger job"));
  });
});

describe("migrateRoleLearnings — self-heal legacy flat-store learnings (§7)", () => {
  it("moves global learnings tagged for a slug into the role store, idempotently", () => {
    const home = freshRoot();
    const { global, mem } = scoped(home);
    mem.setRole("finance");
    const roleStore = mem.storeFor("role")!;
    // Legacy: a finance learning + a docs learning both sitting in the flat global store.
    storeLearning(global, learning({ statement: "Legacy finance learning in the flat store.", subject: "finance", roleSlug: "finance" }));
    storeLearning(global, learning({ statement: "Legacy docs learning in the flat store.", subject: "docs", roleSlug: "docs" }));

    const moved = migrateRoleLearnings(global, roleStore, "finance");
    expect(moved).toBe(1); // only the finance one
    expect(loadLearnings(roleStore, "finance")).toHaveLength(1);
    expect(loadLearnings(global, "finance")).toHaveLength(0); // left global
    expect(loadLearnings(global, "docs")).toHaveLength(1); // the docs one is untouched

    // Idempotent — a second run moves nothing.
    expect(migrateRoleLearnings(global, roleStore, "finance")).toBe(0);
  });

  it("moving into the same directory is a no-op (guards self-move)", () => {
    const home = freshRoot();
    const { global } = scoped(home);
    storeLearning(global, learning({ statement: "A learning.", subject: "x", roleSlug: "x" }));
    expect(migrateRoleLearnings(global, global, "x")).toBe(0);
    expect(loadLearnings(global)).toHaveLength(1);
  });
});
