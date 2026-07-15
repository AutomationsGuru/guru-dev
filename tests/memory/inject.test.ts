import { describe, expect, it } from "vitest";

import { LearningSchema, learningId } from "../../src/garage/flywheel.js";
import { mergeFactSourceInjection } from "../../src/memory/inject.js";
import type { MemoryFactEntry } from "../../src/memory/store.js";

const NOW = new Date("2026-07-14T00:00:00.000Z");

function fact(name: string, title: string, description: string, updatedAt = NOW.toISOString()): MemoryFactEntry {
  return {
    fact: {
      name,
      title,
      description,
      type: "project",
      createdAt: NOW.toISOString(),
      updatedAt,
      confidence: 1
    },
    body: description
  };
}

describe("mergeFactSourceInjection", () => {
  it("orders backend entries by updatedAt instead of relying on traversal order", () => {
    const injection = mergeFactSourceInjection(
      [
        {
          scope: "global",
          entries: [
            fact("newest", "Newest fact", "newest description", "2026-07-14T00:00:00.000Z"),
            fact("oldest", "Oldest fact", "oldest description", "2026-07-01T00:00:00.000Z")
          ]
        }
      ],
      []
    );

    expect(injection.block.indexOf("Newest fact")).toBeLessThan(injection.block.indexOf("Oldest fact"));
  });

  it("keeps the newest 50 facts when a backend returns more than the injection cap", () => {
    const entries = Array.from({ length: 51 }, (_, index) => {
      return fact(
        `fact-${index}`,
        `Fact ${String(index).padStart(2, "0")}`,
        `Description ${index}`,
        new Date(NOW.getTime() - index * 86_400_000).toISOString()
      );
    });

    const injection = mergeFactSourceInjection([{ scope: "global", entries }], []);

    expect(injection.block).toContain("[Fact 00](fact-0.md)");
    expect(injection.block).not.toContain("[Fact 50](fact-50.md)");
  });

  it("merges provider-neutral scoped entries with local learnings", () => {
    const statement = "The finance role validates ledger totals before reporting them.";
    const learning = LearningSchema.parse({
      id: learningId("role", "L1", statement),
      scope: "role",
      roleSlug: "finance",
      level: "L1",
      statement,
      subject: "ledger-validation",
      createdAt: NOW.toISOString()
    });

    const injection = mergeFactSourceInjection(
      [
        { scope: "global", entries: [fact("policy", "Global policy", "generic behavior")] },
        { scope: "space", entries: [fact("policy", "Project policy", "project-specific behavior")] },
        { scope: "role", entries: [fact("ledger-check", "Ledger check", "validate finance totals")] }
      ],
      [{ scope: "role", learnings: [learning] }],
      { now: () => NOW }
    );

    expect(injection.block).toContain("Project policy");
    expect(injection.block).toContain("project-specific behavior  ·space");
    expect(injection.block).not.toContain("Global policy");
    expect(injection.block).toContain("Ledger check");
    expect(injection.block).toContain("validate finance totals  ·role");
    expect(injection.block).toContain(`${statement}  ·role`);
    expect(injection.injectedLearningIds).toEqual([learning.id]);
  });
});
