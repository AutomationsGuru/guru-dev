import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore } from "../../src/memory/store.js";
import { buildBootMemoryInjection } from "../../src/memory/inject.js";
import { LearningSchema, learningId, type Learning } from "../../src/garage/flywheel.js";
import { loadLearnings, pruneLearning, storeLearning } from "../../src/garage/flywheelStore.js";

let n = 0;
const dirs: string[] = [];
function freshMemory() {
  const directory = join(tmpdir(), `guru-fly-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function learning(over: Partial<Learning> & { statement: string; subject: string }): Learning {
  return LearningSchema.parse({
    id: over.id ?? learningId(over.scope ?? "role", over.level ?? "L1", over.statement),
    scope: "role",
    level: "L1",
    createdAt: "2026-07-05T00:00:00.000Z",
    ...over
  });
}

describe("flywheelStore — STORE / load / prune", () => {
  it("stores a learning and loads it back", () => {
    const memory = freshMemory();
    storeLearning(memory, learning({ statement: "Tool git.pr.run helps the finance suit.", subject: "finance", tools: ["git.pr.run"] }));
    const loaded = loadLearnings(memory);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.statement).toContain("git.pr.run");
    expect(loaded[0]?.tools).toEqual(["git.pr.run"]);
  });

  it("idempotent: re-storing the same learning id updates in place (no duplicate)", () => {
    const memory = freshMemory();
    const l = learning({ statement: "Reconcile the ledger nightly.", subject: "ledger" });
    storeLearning(memory, l);
    storeLearning(memory, { ...l, citations: [{ at: "2026-07-05T01:00:00.000Z", outcome: "used" }] });
    const loaded = loadLearnings(memory);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.citations).toHaveLength(1);
  });

  it("prune moves a learning to .trash (DECAY)", () => {
    const memory = freshMemory();
    const l = learning({ statement: "A stale learning to be pruned.", subject: "stale" });
    storeLearning(memory, l);
    pruneLearning(memory, l.id, "flywheel decay: stale + uncited");
    expect(loadLearnings(memory)).toHaveLength(0);
  });

  it("loadLearnings can filter by role slug", () => {
    const memory = freshMemory();
    storeLearning(memory, learning({ statement: "Finance suit learning here.", subject: "f", roleSlug: "finance" }));
    storeLearning(memory, learning({ statement: "Docs suit learning here.", subject: "d", roleSlug: "docs" }));
    expect(loadLearnings(memory, "finance")).toHaveLength(1);
  });
});

describe("boot injection — the flywheel INJECT stage", () => {
  it("learnings are EXCLUDED from the flat index and injected in their own decay-ranked section", () => {
    const memory = freshMemory();
    // A normal fact + a learning.
    memory.remember({ name: "some-fact", title: "Some fact", description: "a normal memory", body: "body", type: "project", edit: "replace", confidence: 1 });
    storeLearning(memory, learning({ statement: "Cited finance learning that should rank high.", subject: "finance", tools: ["git.pr.run"], citations: [{ at: "2026-07-05T00:00:00.000Z", outcome: "used" }] }));
    const injection = buildBootMemoryInjection(memory, { now: () => new Date(Date.UTC(2026, 6, 5)) });
    expect(injection.block).toContain("Guru learned");
    expect(injection.block).toContain("Cited finance learning");
    // The learning is NOT double-listed in the general index section.
    expect(injection.block).not.toMatch(/\[.*\]\(learning-.*\.md\)/u);
    // The injected id is returned so the session can CITE it.
    expect(injection.injectedLearningIds).toHaveLength(1);
  });

  it("no facts and no learnings → empty block", () => {
    const memory = freshMemory();
    expect(buildBootMemoryInjection(memory).block).toBe("");
    expect(buildBootMemoryInjection(memory).injectedLearningIds).toEqual([]);
  });
});
