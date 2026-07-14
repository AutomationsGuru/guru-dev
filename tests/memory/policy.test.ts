import { describe, expect, it } from "vitest";

import {
  buildMemoryGetResult,
  memoryTokenOverlap,
  planMemoryRemember,
  planPreflightedMemoryRemember,
  preflightMemoryRemember,
  searchMemoryEntries,
  tokenizeMemoryText,
  type MemoryFactEntry
} from "../../src/memory/policy.js";
import { MEMORY_BODY_HARD_CAP } from "../../src/memory/schemas.js";

const TIMESTAMP = "2026-07-12T00:00:00.000Z";

function entry(
  name: string,
  title: string,
  description: string,
  body = "body",
  updatedAt = "2026-07-02T00:00:00.000Z"
): MemoryFactEntry {
  return {
    fact: {
      name,
      title,
      description,
      type: "project",
      createdAt: updatedAt,
      updatedAt,
      confidence: 1
    },
    body
  };
}

describe("shared memory remember policy", () => {
  it("preflights schema normalization before facts and timestamps are needed", () => {
    const preflight = preflightMemoryRemember({
      title: "  Shared preflight  ",
      description: "  Normalize once  ",
      body: "  Body text  "
    });

    expect(preflight).toMatchObject({
      kind: "ready",
      input: {
        title: "Shared preflight",
        description: "Normalize once",
        body: "Body text",
        type: "project",
        edit: "replace",
        confidence: 1
      }
    });
    if (preflight.kind !== "ready") throw new Error("expected a ready memory preflight");
    expect(planPreflightedMemoryRemember(preflight, [], { timestamp: TIMESTAMP })).toMatchObject({
      kind: "create",
      name: "shared-preflight"
    });
  });

  it("blocks secret-shaped writes without returning the secret value", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx1234";

    const plan = planMemoryRemember(
      {
        title: "Provider key note",
        description: "How to authenticate",
        body: `Use ${secret} for the lane`,
        type: "project",
        edit: "replace",
        confidence: 1
      },
      [],
      { timestamp: TIMESTAMP }
    );

    expect(plan.kind).toBe("blocked");
    expect(plan.result.blockers.join(" ")).toMatch(/potential secret|token-shaped value/);
    expect(JSON.stringify(plan.result)).not.toContain(secret);
  });

  it("plans an in-place append while preserving creation metadata", () => {
    const existing = entry("shared-policy", "Shared policy", "One fact engine", "first", "2026-07-01T00:00:00.000Z");

    const plan = planMemoryRemember(
      {
        name: "shared-policy",
        title: "Shared policy",
        description: "One fact engine for every backend",
        body: "second",
        type: "project",
        edit: "append",
        confidence: 0.9
      },
      [existing],
      { timestamp: TIMESTAMP, sessionId: "new-session" }
    );

    expect(plan).toMatchObject({
      kind: "update",
      name: "shared-policy",
      body: "first\n\nsecond",
      fact: {
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: TIMESTAMP
      },
      result: { status: "updated" }
    });
    expect(plan.kind === "update" ? plan.fact : undefined).not.toHaveProperty("originSessionId");
  });

  it("blocks an append that would cross the hard cap without emitting a changed fact or body", () => {
    const existing = entry(
      "near-cap-fact",
      "Near-cap fact",
      "Append must honor the resulting-body cap",
      "x".repeat(MEMORY_BODY_HARD_CAP - 1)
    );

    const plan = planMemoryRemember(
      {
        name: "near-cap-fact",
        title: "Near-cap fact",
        description: "Append must honor the resulting-body cap",
        body: "y",
        type: "project",
        edit: "append",
        confidence: 1
      },
      [existing],
      { timestamp: TIMESTAMP }
    );

    expect(plan).toMatchObject({ kind: "blocked", result: { status: "blocked" } });
    expect(plan.result.blockers[0]).toContain("resulting body would be");
    expect(plan).not.toHaveProperty("fact");
    expect(plan).not.toHaveProperty("body");
  });

  it("blocks a similar implicit fact but permits an explicit new name", () => {
    const entries = [entry("grok-lane-wiring-endpoint", "grok lane wiring endpoint", "grok speaks openai responses at the cli chat proxy endpoint")];
    const input = {
      title: "how grok connects",
      description: "grok openai responses cli chat proxy endpoint wiring",
      body: "verified",
      type: "project" as const,
      edit: "replace" as const,
      confidence: 1
    };

    const blocked = planMemoryRemember(input, entries, { timestamp: TIMESTAMP });
    const explicit = planMemoryRemember({ ...input, name: "grok-lane-wiring-v2" }, entries, { timestamp: TIMESTAMP, sessionId: "session-2" });

    expect(blocked).toMatchObject({ kind: "blocked", result: { blockers: ["similar-to:grok-lane-wiring-endpoint"] } });
    expect(explicit).toMatchObject({
      kind: "create",
      name: "grok-lane-wiring-v2",
      fact: { originSessionId: "session-2" },
      result: { status: "created" }
    });
  });
});

describe("shared memory read policy", () => {
  it("builds links, backlinks, dangling links, and staleness from loaded entries", () => {
    const entries = [
      entry("target-fact", "Target fact", "The requested fact", "See [[known-fact]] and [[missing-fact]]."),
      entry("known-fact", "Known fact", "A linked fact"),
      entry("backlink-fact", "Backlink fact", "Points back", "See [[target-fact]].")
    ];

    const result = buildMemoryGetResult("target-fact", entries, new Date(TIMESTAMP));

    expect(result).toMatchObject({
      found: true,
      links: ["known-fact", "missing-fact"],
      backlinks: ["backlink-fact"],
      danglingLinks: ["missing-fact"]
    });
    expect(result.stalenessBanner).toContain("10 days old");
  });

  it("scores two-character terms consistently and filters by fact type", () => {
    const entries = [
      entry("js-ai-notes", "JS AI notes", "go db integration"),
      { ...entry("reference-note", "JS reference", "unrelated"), fact: { ...entry("reference-note", "JS reference", "unrelated").fact, type: "reference" as const } }
    ];

    const result = searchMemoryEntries({ terms: "js ai db", type: "project", limit: 6 }, entries);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ name: "js-ai-notes", score: 1 });
  });
});

describe("shared memory similarity primitives", () => {
  it("normalizes tokens and computes overlap against the smaller set", () => {
    const left = tokenizeMemoryText("JS, AI, and database wiring");
    const right = tokenizeMemoryText("ai JS endpoint");

    expect([...left]).toEqual(["js", "ai", "and", "database", "wiring"]);
    expect(memoryTokenOverlap(left, right)).toBeCloseTo(2 / 3);
  });
});
