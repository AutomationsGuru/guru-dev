import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkCardDependencyCycleError,
  allocateWorktreePath,
  createWorkCardStore,
  resolveWorkCardDirectory,
  resolveWorkCardWorktreeRoot,
  wouldCreateDependencyCycle
} from '../../src/fleet/workCard.js';
import {
  CreateWorkCardInputSchema,
  WorkCardSchema,
  WorkCardStatusSchema
} from '../../src/fleet/workCardSchema.js';

const temps: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-work-card-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("workCardSchema — closed status + strict card shape", () => {
  it("accepts the MVP status enum and rejects free-form status", () => {
    expect(WorkCardStatusSchema.parse("backlog")).toBe("backlog");
    expect(WorkCardStatusSchema.parse("ready")).toBe("ready");
    expect(WorkCardStatusSchema.parse("in_progress")).toBe("in_progress");
    expect(WorkCardStatusSchema.parse("done")).toBe("done");
    expect(() => WorkCardStatusSchema.parse("shipped")).toThrow();
  });

  it("requires id/title/status/timestamps; dependsOn defaults to []", () => {
    const card = WorkCardSchema.parse({
      id: "abc",
      title: "Ship work card MVP",
      status: "backlog",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    });
    expect(card.dependsOn).toEqual([]);
    expect(card.worktreePath).toBeUndefined();
  });

  it("create input requires a non-empty title", () => {
    expect(() => CreateWorkCardInputSchema.parse({ title: "" })).toThrow();
    expect(CreateWorkCardInputSchema.parse({ title: "ok" }).title).toBe("ok");
  });
});

describe("wouldCreateDependencyCycle — pure graph check", () => {
  it("self-dependency is a cycle", () => {
    expect(wouldCreateDependencyCycle(new Map(), "a", ["a"])).toBe(true);
  });

  it("A→B→A is a cycle when adding B dependsOn A while A already depends on B", () => {
    const existing = new Map<string, readonly string[]>([["a", ["b"]]]);
    expect(wouldCreateDependencyCycle(existing, "b", ["a"])).toBe(true);
  });

  it("a simple chain A→B→C is not a cycle", () => {
    const existing = new Map<string, readonly string[]>([
      ["b", ["c"]],
      ["c", []]
    ]);
    expect(wouldCreateDependencyCycle(existing, "a", ["b"])).toBe(false);
  });

  it("missing dependency targets are not cycles", () => {
    expect(wouldCreateDependencyCycle(new Map(), "a", ["missing-upstream"])).toBe(false);
  });
});

describe("path helpers", () => {
  it("resolve helpers land under project .guru", () => {
    expect(resolveWorkCardDirectory("/proj")).toMatch(/[/\\]\.guru[/\\]cards$/);
    expect(resolveWorkCardWorktreeRoot("/proj")).toMatch(/[/\\]\.guru[/\\]worktrees$/);
    expect(allocateWorktreePath("/proj/.guru/worktrees", "card1")).toMatch(
      /[/\\]worktrees[/\\]card1$/
    );
  });
});

describe("createWorkCardStore — create / list / cycle reject", () => {
  it("createCard allocates a worktree dir under .guru/worktrees/<id> and persists the card", () => {
    const projectRoot = tempProject();
    let n = 0;
    const store = createWorkCardStore({
      projectRoot,
      generateId: () => `card-${++n}`,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });

    const card = store.createCard({ title: "Implement fleet work card" });
    expect(card.id).toBe("card-1");
    expect(card.title).toBe("Implement fleet work card");
    expect(card.status).toBe("backlog");
    expect(card.dependsOn).toEqual([]);
    expect(card.worktreePath).toBe(join(projectRoot, ".guru", "worktrees", "card-1"));
    expect(existsSync(card.worktreePath!)).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(projectRoot, ".guru", "cards", "card-1.json"), "utf8")
    );
    expect(onDisk).toMatchObject({
      id: "card-1",
      title: "Implement fleet work card",
      status: "backlog",
      worktreePath: card.worktreePath
    });

    expect(store.getCard("card-1")).toEqual(card);
  });

  it("createCard can skip worktree allocation when allocateWorktree=false", () => {
    const projectRoot = tempProject();
    const store = createWorkCardStore({
      projectRoot,
      generateId: () => "no-wt",
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });
    const card = store.createCard({ title: "No isolation", allocateWorktree: false });
    expect(card.worktreePath).toBeUndefined();
    expect(existsSync(join(projectRoot, ".guru", "worktrees", "no-wt"))).toBe(false);
  });

  it("listCards returns all cards and filters by status", () => {
    const projectRoot = tempProject();
    let n = 0;
    const store = createWorkCardStore({
      projectRoot,
      generateId: () => `c${++n}`,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });

    store.createCard({ title: "A", status: "backlog" });
    store.createCard({ title: "B", status: "ready" });
    store.createCard({ title: "C", status: "ready" });

    expect(store.listCards()).toHaveLength(3);
    const ready = store.listCards({ status: "ready" });
    expect(ready).toHaveLength(2);
    expect(ready.map((c) => c.title).sort()).toEqual(["B", "C"]);
    expect(store.listCards({ status: "done" })).toEqual([]);
  });

  it("createCard rejects dependsOn that would form a cycle", () => {
    const projectRoot = tempProject();
    let n = 0;
    const store = createWorkCardStore({
      projectRoot,
      generateId: () => `n${++n}`,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });

    const a = store.createCard({ title: "A" });
    // B depends on A — fine
    const b = store.createCard({ title: "B", dependsOn: [a.id] });
    expect(b.dependsOn).toEqual([a.id]);

    // Force the next id so we can set up A→B and then attempt B→A via a third
    // card that closes a longer cycle: create C depending on B, then attempt
    // a card that depends on itself through the existing chain is covered by
    // pure unit tests. Here: attempt to create a card that depends on itself.
    expect(() => store.createCard({ title: "self", dependsOn: ["n3"] })).toThrow(
      WorkCardDependencyCycleError
    );

    // Rebuild a store with a known graph: A depends on B already on disk, then
    // creating B' is not possible with fixed ids — instead seed a file that
    // makes A depend on next-id and reject the create of next-id → A.
  });

  it("createCard rejects a two-node cycle against cards already on disk", () => {
    const projectRoot = tempProject();
    // Seed card "a" that already depends on "b" (b not yet created).
    const cardsDir = join(projectRoot, ".guru", "cards");
    // create via store with fixed ids
    let ids = ["a", "b"];
    let i = 0;
    const store = createWorkCardStore({
      projectRoot,
      generateId: () => ids[i++]!,
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });
    store.createCard({ title: "A", dependsOn: ["b"] });

    // Creating "b" with dependsOn: ["a"] would close A↔B — must reject.
    expect(() => store.createCard({ title: "B", dependsOn: ["a"] })).toThrow(
      WorkCardDependencyCycleError
    );
    // And no partial file for b should have been written.
    expect(existsSync(join(cardsDir, "b.json"))).toBe(false);
    // a remains
    expect(store.getCard("a")?.title).toBe("A");
  });

  it("skips corrupt card files when listing", () => {
    const projectRoot = tempProject();
    const store = createWorkCardStore({
      projectRoot,
      generateId: () => "good",
      now: () => new Date("2026-07-19T12:00:00.000Z")
    });
    store.createCard({ title: "Good" });
    writeFileSync(join(projectRoot, ".guru", "cards", "bad.json"), "{not-json", "utf8");
    writeFileSync(
      join(projectRoot, ".guru", "cards", "wrong-name.json"),
      JSON.stringify({
        id: "other",
        title: "Mismatched filename",
        status: "backlog",
        dependsOn: [],
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:00:00.000Z"
      }),
      "utf8"
    );
    expect(store.listCards()).toHaveLength(1);
    expect(store.listCards()[0]?.id).toBe("good");
  });
});
