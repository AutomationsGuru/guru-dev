import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryStore, type FileMemoryStore } from "../../src/memory/store.js";
import { buildBootMemoryInjection } from "../../src/memory/inject.js";
import { loadLearnings, storeLearning } from "../../src/garage/flywheelStore.js";
import {
  citeLearning,
  extractLearnings,
  gateLearning,
  learningId,
  LearningSchema,
  promoteSweep,
  rankForInjection,
  type Learning
} from "../../src/garage/flywheel.js";

/**
 * The knowledge flywheel, END TO END (THERE §8 / §17 scenario 10 — "the flywheel
 * measurably compounds"). The unit tests prove each stage; this proves the WHOLE
 * loop across cycles + transfer with the REAL functions over a real memory store:
 * EXTRACT → GATE → STORE → INJECT (decay-ranked) → CITE → STORE → PROMOTE, and a
 * transferred suit lifting a fresh instance.
 */

const PROMOTION = { promoteToSkill: 2, promoteToRule: 4, demoteAfterSessions: 12 };
const now = () => new Date(Date.UTC(2026, 6, 5));

let n = 0;
const dirs: string[] = [];
function freshStore(): FileMemoryStore {
  const directory = join(tmpdir(), `guru-fw-e2e-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return createFileMemoryStore({ directory, now });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A VALIDATED L1 learning (curated → promotable), vs extract's self-generated ones. */
function validatedLearning(statement: string, subject: string, tools: string[]): Learning {
  return LearningSchema.parse({
    id: learningId("role", "L1", statement),
    scope: "role",
    roleSlug: "finance",
    level: "L1",
    statement,
    evidence: "curated by the operator",
    subject,
    polarity: "affirm",
    tools,
    validated: true,
    citations: [],
    createdAt: now().toISOString(),
    lastCitedAt: null,
    confidence: 0.6,
    createdSession: 1,
    lastCitedSession: null
  });
}

describe("flywheel E2E (§17 scenario 10): the garage measurably compounds", () => {
  it("day-N boot injects what day-1 learned; citations accumulate; injection is decay-ranked", () => {
    const memory = freshStore();

    // --- Day 1 park: EXTRACT self-generated learnings, GATE, STORE. ---
    const extracted = extractLearnings({ roleSlug: "finance", toolsUsed: ["git.pr.run"], routeId: "sonnet", turns: 5, now, currentSession: 1 });
    expect(extracted.length).toBeGreaterThan(0);
    const existing = new Set<string>();
    for (const learning of extracted) {
      expect(gateLearning(learning, existing).admit).toBe(true);
      storeLearning(memory, learning);
      existing.add(learning.id);
    }

    // --- Day 2 boot: the flywheel INJECTS them (they survived the park). ---
    const day2 = buildBootMemoryInjection(memory, { now });
    expect(day2.injectedLearningIds.length).toBeGreaterThan(0);
    expect(day2.block).toContain("Guru learned");

    // --- Day 2 use: CITE an injected learning (it was applied) and re-store. ---
    const target = loadLearnings(memory).find((l) => l.tools.includes("git.pr.run"))!;
    expect(target.citations).toHaveLength(0);
    storeLearning(memory, citeLearning(target, { at: now().toISOString(), outcome: "used in a finance PR" }, 2));

    const afterCite = loadLearnings(memory).find((l) => l.id === target.id)!;
    expect(afterCite.citations).toHaveLength(1); // compounded
    expect(afterCite.confidence).toBeGreaterThan(target.confidence); // citation lifts confidence
    // Self-generated stays L1 forever — the validation GATE holds (no auto-promotion of unvetted knowledge).
    expect(afterCite.level).toBe("L1");
  });

  it("a VALIDATED, cited L1 promotes to an L2 skill (validation-gated promotion), then injects at its new level", () => {
    const memory = freshStore();
    const seed = validatedLearning("Reconcile the finance ledger before opening a PR.", "finance-ledger", ["git.pr.run"]);
    storeLearning(memory, seed);

    // Two citations cross the L1→L2 threshold.
    let current = seed;
    for (const session of [2, 3]) {
      current = citeLearning(current, { at: now().toISOString(), outcome: `applied in session ${session}` }, session);
      storeLearning(memory, current);
    }
    expect(loadLearnings(memory)[0]?.citations).toHaveLength(2);

    // PROMOTE sweep: validated + 2 cites → L2. Re-id the fact, prune the old L1.
    const promotion = promoteSweep(loadLearnings(memory), 3, PROMOTION);
    expect(promotion.promoted).toHaveLength(1);
    const change = promotion.promoted[0]!;
    expect(change.from).toBe("L1");
    expect(change.to).toBe("L2");
    storeLearning(memory, change.learning);
    if (change.oldId !== change.learning.id) {
      memory.forget({ name: `learning-${change.oldId}`, reason: "flywheel: L1->L2" });
    }

    const promoted = loadLearnings(memory);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.level).toBe("L2"); // compounded UP a level

    // The promoted skill injects at its new level.
    const injection = buildBootMemoryInjection(memory, { now });
    expect(injection.block).toContain("L2");
    expect(injection.block).toContain("Reconcile the finance ledger");
  });

  it("INJECT is decay-ranked: a cited learning outranks an uncited sibling", () => {
    const cited = validatedLearning("Cited finance rule that has been applied.", "finance-a", ["git.pr.run"]);
    const uncited = validatedLearning("Uncited finance note nobody used yet.", "finance-b", ["read"]);
    const citedApplied = citeLearning(citeLearning(cited, { at: now().toISOString(), outcome: "x" }, 2), { at: now().toISOString(), outcome: "y" }, 3);
    const ranked = rankForInjection([uncited, citedApplied], { now: now(), budget: { maxLines: 8, maxChars: 1400 } });
    expect(ranked[0]?.id).toBe(citedApplied.id); // citations lift it above the uncited sibling
  });

  it("TRANSFER: a suit's learnings lift a FRESH instance — copy them into a new store and it injects them at boot", () => {
    const origin = freshStore();
    for (const learning of extractLearnings({ roleSlug: "finance", toolsUsed: ["git.pr.run", "review.gates.run"], routeId: "sonnet", turns: 6, now, currentSession: 1 })) {
      storeLearning(origin, learning);
    }
    const originLearnings = loadLearnings(origin);
    expect(originLearnings.length).toBeGreaterThan(0);

    // A fresh machine/instance with an EMPTY store learns nothing at boot...
    const fresh = freshStore();
    expect(buildBootMemoryInjection(fresh, { now }).injectedLearningIds).toHaveLength(0);

    // ...until the suit is transferred (its learnings copied in). Then it boots lifted.
    for (const learning of originLearnings) {
      storeLearning(fresh, learning);
    }
    const lifted = buildBootMemoryInjection(fresh, { now });
    expect(lifted.injectedLearningIds.length).toBe(originLearnings.length);
    expect(loadLearnings(fresh).map((l) => l.id).sort()).toEqual(originLearnings.map((l) => l.id).sort());
  });
});
