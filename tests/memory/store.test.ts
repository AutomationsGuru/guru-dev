import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildBootMemoryBlock } from "../../src/memory/inject.js";
import { parseFactFile, serializeFactFile, extractLinks } from "../../src/memory/frontmatter.js";
import { createFileMemoryStore, type FileMemoryStore } from "../../src/memory/store.js";
import { slugifyFactName } from "../../src/memory/schemas.js";

const cleanups: string[] = [];

function makeStore(now?: () => Date): { store: FileMemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "guru-memory-test-"));
  cleanups.push(dir);
  const store = createFileMemoryStore({ directory: dir, ...(now ? { now } : {}), sessionId: "test-session" });
  return { store, dir };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory store — remember/get round trip (the acceptance core)", () => {
  it("a remembered fact survives a fresh store instance (restart survival)", () => {
    const { store, dir } = makeStore();
    const result = store.remember({
      title: "zai lane needs anthropic-messages",
      description: "zai-coding-cn speaks anthropic-messages at api.z.ai/api/anthropic",
      body: "Verified from the reference working config. See [[provider-wiring]].",
      type: "project",
      edit: "replace",
      confidence: 1
    });
    expect(result.status).toBe("created");
    expect(result.name).toBe("zai-lane-needs-anthropic-messages");

    // Simulate restart: brand-new store over the same directory.
    const reborn = createFileMemoryStore({ directory: dir });
    const got = reborn.get("zai-lane-needs-anthropic-messages");
    expect(got.found).toBe(true);
    expect(got.body).toContain("the reference working config");
    expect(got.fact?.type).toBe("project");
    expect(got.fact?.originSessionId).toBe("test-session");

    // And it appears in the next boot's injection block.
    const block = buildBootMemoryBlock(reborn);
    expect(block).toContain("## Guru memory");
    expect(block).toContain("zai lane needs anthropic-messages");
  });

  it("naked boot: empty dir — every verb works, injection is a no-op", () => {
    const { store } = makeStore();
    expect(buildBootMemoryBlock(store)).toBe("");
    expect(store.list()).toHaveLength(0);
    expect(store.search({ terms: "anything", limit: 6 })).toMatchObject({ hits: [] });
    expect(store.get("nothing-here").found).toBe(false);
    const doctor = store.doctor();
    expect(doctor.factCount).toBe(0);
    expect(doctor.indexRebuilt).toBe(true);
  });
});

describe("memory store — the secret gate (the one that matters most)", () => {
  it("blocks token-shaped values in any field and never writes the file", () => {
    const { store, dir } = makeStore();
    const result = store.remember({
      title: "provider key note",
      description: "how to auth",
      body: "use key sk-abcdefghijklmnopqrstuvwx1234 for the lane",
      type: "project",
      edit: "replace",
      confidence: 1
    });
    expect(result.status).toBe("blocked");
    expect(result.blockers.join(" ")).toMatch(/potential secret|token-shaped value/);
    expect(result.blockers.join(" ")).not.toContain("sk-abcdefghijklmnopqrstuvwx1234"); // kinds/shapes, never values
    expect(readdirSync(dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md")).toHaveLength(0);
    expect(readdirSync(dir).filter((file) => file.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("memory store — update-not-duplicate", () => {
  it("remember with an existing name edits in place (one file, updatedAt bumped)", () => {
    let tick = 0;
    const { store, dir } = makeStore(() => new Date(1751600000000 + tick * 60_000));
    store.remember({ title: "Fact One", description: "first version", body: "v1", type: "project", edit: "replace", confidence: 1 });
    tick = 1;
    const update = store.remember({ name: "fact-one", title: "Fact One", description: "second version", body: "v2", type: "project", edit: "replace", confidence: 1 });
    expect(update.status).toBe("updated");
    const files = readdirSync(dir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md");
    expect(files).toHaveLength(1);
    const got = store.get("fact-one");
    expect(got.body).toBe("v2");
    expect(got.fact?.updatedAt).not.toBe(got.fact?.createdAt);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("second version");
  });

  it("append mode extends the body", () => {
    const { store } = makeStore();
    store.remember({ title: "Append Target", description: "gist", body: "line one", type: "project", edit: "replace", confidence: 1 });
    store.remember({ name: "append-target", title: "Append Target", description: "gist", body: "line two", type: "project", edit: "append", confidence: 1 });
    const got = store.get("append-target");
    expect(got.body).toContain("line one");
    expect(got.body).toContain("line two");
  });

  it("identical title (same slug) is an in-place UPDATE — mechanically update-not-duplicate", () => {
    const { store } = makeStore();
    store.remember({ title: "grok lane wiring endpoint", description: "grok speaks openai-responses at the cli proxy", body: "x", type: "project", edit: "replace", confidence: 1 });
    const same = store.remember({ title: "grok lane wiring endpoint", description: "grok cli proxy endpoint openai responses", body: "y", type: "project", edit: "replace", confidence: 1 });
    expect(same.status).toBe("updated");
    expect(store.get("grok-lane-wiring-endpoint").body).toBe("y");
  });

  it("different title but similar gist WITHOUT a name is blocked naming the existing fact", () => {
    const { store } = makeStore();
    store.remember({ title: "grok lane wiring endpoint", description: "grok speaks openai-responses at the cli-chat proxy endpoint", body: "x", type: "project", edit: "replace", confidence: 1 });
    const dupe = store.remember({ title: "how grok connects", description: "grok openai-responses cli-chat proxy endpoint wiring", body: "y", type: "project", edit: "replace", confidence: 1 });
    expect(dupe.status).toBe("blocked");
    expect(dupe.summary).toContain("[[grok-lane-wiring-endpoint]]");
    expect(dupe.blockers[0]).toContain("similar-to:");
  });

  it("passing an explicit name confirms a new fact despite similarity", () => {
    const { store } = makeStore();
    store.remember({ title: "grok lane wiring endpoint", description: "grok speaks openai-responses at the cli proxy", body: "x", type: "project", edit: "replace", confidence: 1 });
    const confirmed = store.remember({ name: "grok-lane-wiring-v2", title: "grok lane wiring endpoint", description: "grok cli proxy endpoint openai responses", body: "y", type: "project", edit: "replace", confidence: 1 });
    expect(confirmed.status).toBe("created");
    expect(confirmed.name).toBe("grok-lane-wiring-v2");
  });
});

describe("memory store — index is DERIVED state", () => {
  it("hand-deleting a fact file heals out of the index; hand-adding appears", () => {
    const { store, dir } = makeStore();
    store.remember({ title: "Keep Me", description: "stays", body: "body", type: "project", edit: "replace", confidence: 1 });
    store.remember({ title: "Delete Me By Hand", description: "vanishes from index after rebuild", body: "body", type: "reference", edit: "replace", confidence: 1 });
    rmSync(join(dir, "delete-me-by-hand.md"));

    // Hand-add a valid fact file (the Obsidian curation path).
    const handFact = serializeFactFile(
      {
        name: "hand-added-fact",
        title: "Hand Added",
        description: "created in Obsidian",
        type: "user",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        confidence: 1
      },
      "Body written by a human."
    );
    writeFileSync(join(dir, "hand-added-fact.md"), handFact, "utf8");

    const index = store.rebuildIndex();
    expect(index).toContain("Keep Me");
    expect(index).not.toContain("Delete Me By Hand");
    expect(index).toContain("Hand Added");
  });
});

describe("memory store — forget + doctor", () => {
  it("forget moves the file to .trash with the reason and drops the index line", () => {
    const { store, dir } = makeStore();
    store.remember({ title: "Ephemeral Fact", description: "will be forgotten", body: "body", type: "project", edit: "replace", confidence: 1 });
    const result = store.forget({ name: "ephemeral-fact", reason: "test cleanup" });
    expect(result.status).toBe("forgotten");
    expect(existsSync(join(dir, "ephemeral-fact.md"))).toBe(false);
    const trash = readdirSync(join(dir, ".trash"));
    expect(trash.some((file) => file.startsWith("ephemeral-fact."))).toBe(true);
    const trashed = readFileSync(join(dir, ".trash", trash[0] ?? ""), "utf8");
    expect(trashed).toContain("test cleanup");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toContain("Ephemeral Fact");
  });

  it("doctor sweeps orphan temps, GCs old trash, reports dangling links", () => {
    const { store, dir } = makeStore();
    store.remember({ title: "Linker", description: "links out", body: "see [[missing-target]]", type: "project", edit: "replace", confidence: 1 });
    writeFileSync(join(dir, "orphan.md.tmp"), "partial write", "utf8");
    store.remember({ title: "Old Trash", description: "gc me", body: "body", type: "project", edit: "replace", confidence: 1 });
    store.forget({ name: "old-trash", reason: "aging out" });
    const trashFile = readdirSync(join(dir, ".trash"))[0] ?? "";
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(dir, ".trash", trashFile), old, old);

    const report = store.doctor();
    expect(report.orphanTempsRemoved).toBe(1);
    expect(report.trashRemoved).toBe(1);
    expect(report.danglingLinks.some((entry) => entry.includes("missing-target"))).toBe(true);
    expect(report.factCount).toBe(1);
  });
});

describe("memory store — search + staleness + caps", () => {
  it("term-overlap search ranks and filters by type", () => {
    const { store } = makeStore();
    store.remember({ title: "Bedrock mantle surfaces", description: "three disjoint bedrock endpoints", body: "b", type: "reference", edit: "replace", confidence: 1 });
    store.remember({ title: "Azure tier gating", description: "azure deployments tier gated", body: "b", type: "project", edit: "replace", confidence: 1 });
    const hits = store.search({ terms: "bedrock endpoints", limit: 6 });
    expect(hits.hits[0]?.name).toBe("bedrock-mantle-surfaces");
    const typed = store.search({ terms: "bedrock endpoints azure tier", type: "project", limit: 6 });
    expect(typed.hits.every((hit) => hit.type === "project")).toBe(true);
  });

  it("staleness banner reports age from updatedAt", () => {
    const base = new Date("2026-07-01T00:00:00.000Z");
    let current = base;
    const { store } = makeStore(() => current);
    store.remember({ title: "Aging Fact", description: "gets old", body: "b", type: "project", edit: "replace", confidence: 1 });
    current = new Date("2026-07-11T00:00:00.000Z");
    const got = store.get("aging-fact");
    expect(got.stalenessBanner).toContain("10 days old");
  });

  it("bodies over the 32KB hard cap are refused with a split blocker", () => {
    const { store } = makeStore();
    const result = store.remember({ title: "Huge Fact", description: "too big", body: "x".repeat(33 * 1024), type: "project", edit: "replace", confidence: 1 });
    expect(result.status).toBe("blocked");
    expect(result.blockers[0]).toContain("split this fact");
  });
});

describe("frontmatter — Obsidian-standard round trip", () => {
  it("serialize -> parse round-trips fields and body, emits type tags", () => {
    const fact = {
      name: "round-trip",
      title: "Title: with a colon",
      description: "gist here",
      type: "capability" as const,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T01:00:00.000Z",
      confidence: 0.8,
      originSessionId: "abc-123"
    };
    const text = serializeFactFile(fact, "Body with [[a-link]] inside.");
    expect(text).toContain("tags: [memory/capability]");
    expect(text.startsWith("---\n")).toBe(true);
    const parsed = parseFactFile(text);
    expect(parsed?.fact).toEqual(fact);
    expect(parsed?.body).toBe("Body with [[a-link]] inside.");
    expect(extractLinks(parsed?.body ?? "")).toEqual(["a-link"]);
  });

  it("malformed files parse to undefined (skip-and-report, never throw)", () => {
    expect(parseFactFile("no frontmatter at all")).toBeUndefined();
    expect(parseFactFile("---\nname: bad slug!!\n---\nbody")).toBeUndefined();
  });

  it("slugify produces valid names", () => {
    expect(slugifyFactName("Grok Lane: Wiring & Endpoints!")).toBe("grok-lane-wiring-endpoints");
    expect(slugifyFactName("A B")).toBe("a-b"); // 3 chars — already a valid slug
    expect(slugifyFactName("A")).toBe("a-fact"); // too short — padded
  });
});
