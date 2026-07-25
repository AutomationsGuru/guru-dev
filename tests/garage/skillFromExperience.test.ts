import { describe, expect, it } from "vitest";

import {
  draftSkill,
  skillNameFromTitle
} from '../../src/garage/skillFromExperience.js';

describe("skillNameFromTitle", () => {
  it("derives a stable lowercase slug from a title", () => {
    expect(skillNameFromTitle("Retry Flaky Network Calls")).toBe(
      "retry-flaky-network-calls"
    );
    expect(skillNameFromTitle("  Ship Draft Skill  ")).toBe("ship-draft-skill");
  });
});

describe("draftSkill — skill-from-experience (IDEA-F176)", () => {
  it("happy path: returns SKILL.md-shaped markdown + draft meta", () => {
    const result = draftSkill({
      title: "Retry Flaky Network Calls",
      when: "When an HTTP request fails with a transient error",
      steps: [
        "Classify the error as transient vs permanent",
        "Backoff exponentially up to three attempts",
        "Surface a clear failure if all retries exhaust"
      ]
    });

    expect(result.markdown).toContain("# Retry Flaky Network Calls");
    expect(result.markdown).toContain(
      "When an HTTP request fails with a transient error"
    );
    expect(result.markdown).toContain(
      "1. Classify the error as transient vs permanent"
    );
    expect(result.markdown).toContain(
      "2. Backoff exponentially up to three attempts"
    );
    expect(result.markdown).toContain(
      "3. Surface a clear failure if all retries exhaust"
    );
    expect(result.markdown).toMatch(/^---\nname: retry-flaky-network-calls\n/u);
    expect(result.markdown).toContain("description: When an HTTP request fails with a transient error");
    expect(result.markdown).toContain("## When to use");
    expect(result.markdown).toContain("## Steps");

    expect(result.meta.stage).toBe("draft");
    expect(result.meta.source).toBe("experience");
    expect(result.meta.title).toBe("Retry Flaky Network Calls");
    expect(result.meta.when).toBe(
      "When an HTTP request fails with a transient error"
    );
    expect(result.meta.name).toBe("retry-flaky-network-calls");
    expect(result.meta.steps).toHaveLength(3);
    expect(result.meta.stepCount).toBe(3);
    expect(result.meta.steps).toEqual([
      "Classify the error as transient vs permanent",
      "Backoff exponentially up to three attempts",
      "Surface a clear failure if all retries exhaust"
    ]);
  });

  it("trims title, when, and steps before embedding", () => {
    const result = draftSkill({
      title: "  Ship Draft Skill  ",
      when: "  After a successful flywheel extract  ",
      steps: ["  Write the body  ", "  Leave stage as draft  "]
    });

    expect(result.meta.title).toBe("Ship Draft Skill");
    expect(result.meta.when).toBe("After a successful flywheel extract");
    expect(result.meta.steps).toEqual([
      "Write the body",
      "Leave stage as draft"
    ]);
    expect(result.meta.stepCount).toBe(2);
    expect(result.meta.name).toBe("ship-draft-skill");
    expect(result.markdown).toContain("name: ship-draft-skill");
  });

  it("rejects an empty steps array", () => {
    expect(() =>
      draftSkill({
        title: "Empty Steps Skill",
        when: "Never",
        steps: []
      })
    ).toThrow();
  });

  it("rejects blank-only steps", () => {
    expect(() =>
      draftSkill({
        title: "Blank Steps Skill",
        when: "Never",
        steps: ["  ", "\t", ""]
      })
    ).toThrow();
  });

  it("rejects blank title or when", () => {
    expect(() =>
      draftSkill({
        title: "   ",
        when: "Valid when",
        steps: ["Do the thing"]
      })
    ).toThrow();

    expect(() =>
      draftSkill({
        title: "Valid title",
        when: "  ",
        steps: ["Do the thing"]
      })
    ).toThrow();
  });
});
