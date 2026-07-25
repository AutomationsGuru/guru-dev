import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLearnings } from "../../src/garage/flywheelStore.js";
import { shapeStowedLearning, stowLearning } from "../../src/memory/stow.js";
import { createFileMemoryStore } from "../../src/memory/store.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
});

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "guru-memory-stow-"));
  tempDirectories.push(directory);
  return createFileMemoryStore({ directory, now: () => new Date("2026-07-18T00:00:00.000Z") });
}

const NOW = new Date("2026-07-18T00:00:00.000Z");

describe("shapeStowedLearning", () => {
  it("produces a full decay-ready learning with all GATE fields", () => {
    const learning = shapeStowedLearning(
      {
        statement: "The builder lane must leave a dirty overlay, never commit.",
        evidence: "session: 12 turns on route builder",
        tools: ["Edit", "Bash"],
        validated: true,
        confidence: 0.9,
        currentSession: 7
      },
      NOW
    );

    expect(learning.id).toMatch(/^l[a-f0-9]{12}$/u);
    expect(learning.level).toBe("L1");
    expect(learning.scope).toBe("global");
    expect(learning.validated).toBe(true);
    expect(learning.citations).toEqual([]);
    expect(learning.createdAt).toBe(NOW.toISOString());
    expect(learning.lastCitedAt).toBeNull();
    expect(learning.createdSession).toBe(7);
    expect(learning.lastCitedSession).toBeNull();
    expect(learning.subject.length).toBeGreaterThan(0);
  });

  it("honors an explicit subject and role scope", () => {
    const learning = shapeStowedLearning(
      {
        statement: "Role suits park richer than they started, always.",
        scope: "role",
        roleSlug: "builder",
        subject: "garage-park"
      },
      NOW
    );

    expect(learning.scope).toBe("role");
    expect(learning.roleSlug).toBe("builder");
    expect(learning.subject).toBe("garage-park");
  });
});

describe("stowLearning — GATE → STORE", () => {
  it("stows a specific, novel learning as a decay-ready learning fact", () => {
    const store = makeStore();

    const receipt = stowLearning(store, {
      statement: "The builder lane must leave a dirty overlay, never commit.",
      evidence: "session: 12 turns",
      tools: ["Edit"],
      validated: true
    });

    expect(receipt.status).toBe("stowed");
    expect(receipt.learningId).toBeDefined();
    expect(receipt.factName).toMatch(/^learning-/u);

    const stored = loadLearnings(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.statement).toContain("dirty overlay");
    expect(stored[0]?.validated).toBe(true);
  });

  it("REFUSES a too-vague statement at the GATE (not stowed)", () => {
    const store = makeStore();

    const receipt = stowLearning(store, { statement: "short" });

    expect(receipt.status).toBe("refused");
    expect(receipt.gateReason).toContain("not specific enough");
    expect(loadLearnings(store)).toHaveLength(0);
  });

  it("re-stows an exact duplicate idempotently as an update, not a new fact", () => {
    const store = makeStore();
    const input = { statement: "Memory that only grows is future confusion, prune it." };

    const first = stowLearning(store, input);
    const second = stowLearning(store, input);

    expect(first.status).toBe("stowed");
    expect(second.status).toBe("updated");
    expect(second.learningId).toBe(first.learningId);
    expect(loadLearnings(store)).toHaveLength(1);
  });

  it("blocks a learning whose body carries a secret (memory organ scrub gate)", () => {
    const store = makeStore();

    const receipt = stowLearning(store, {
      statement: "A learning long enough to pass the gate but holding a key.",
      evidence: "-----BEGIN PRIVATE KEY-----\nsecret\n"
    });

    // The memory organ's secret-scrub refuses the write; the block surfaces in
    // the receipt summary (storeLearning forwards the organ's blocked summary)
    // and nothing lands as a parseable learning.
    expect(receipt.summary).toContain("secret");
    expect(loadLearnings(store)).toHaveLength(0);
  });
});
