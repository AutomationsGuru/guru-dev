import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLocalFirstAgentStore,
  deserializeAgentMeta,
  pathsFor,
  resolveAgentsRoot,
  serializeAgentMeta,
  type LocalAgentMeta
} from '../../src/memory/localFirstAgentStore.js';

/**
 * Local-first agent store (IDEA-F197, R-LT-LOCAL-STORE).
 *
 * The filesystem substrate under a profile root:
 *   <root>/agents/<agentId>/meta.json
 *   <root>/agents/<agentId>/blocks/<label>.md
 *
 * Pure path helpers + serialize/load. No Letta cloud, no framework — the
 * profile-local layout that F174 (identity blocks) and F177 (versioned
 * export) compose over.
 */

let root: string;

function metaFixture(over: Partial<LocalAgentMeta> = {}): LocalAgentMeta {
  return {
    agentId: "agent-1234abcd",
    version: 1,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...over
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guru-f197-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveAgentsRoot", () => {
  it("places agents under the given profile root", () => {
    expect(resolveAgentsRoot("/profile")).toBe(join("/profile", "agents"));
  });
});

describe("pathsFor", () => {
  it("maps an agent id to its directory, meta file, and blocks dir under the root", () => {
    const paths = pathsFor(root, "agent-abc");
    const agentsRoot = join(root, "agents");
    expect(paths.agentDir).toBe(join(agentsRoot, "agent-abc"));
    expect(paths.metaFile).toBe(join(agentsRoot, "agent-abc", "meta.json"));
    expect(paths.blocksDir).toBe(join(agentsRoot, "agent-abc", "blocks"));
    // Every resolved path stays under the agents root.
    for (const p of [paths.agentDir, paths.metaFile, paths.blocksDir]) {
      const rel = resolve(p).startsWith(resolve(agentsRoot) + sep);
      expect(rel, `${p} escapes ${agentsRoot}`).toBe(true);
    }
  });

  it("rejects ids that would escape the root (path traversal)", () => {
    expect(() => pathsFor(root, "../escape")).toThrow();
    expect(() => pathsFor(root, "..")).toThrow();
    expect(() => pathsFor(root, "a/b")).toThrow();
    expect(() => pathsFor(root, "a\\b")).toThrow();
    expect(() => pathsFor(root, "")).toThrow();
  });

  it("rejects ids with unsafe characters", () => {
    expect(() => pathsFor(root, "agent with space")).toThrow();
    expect(() => pathsFor(root, "agent.json")).toThrow();
    expect(() => pathsFor(root, "-leading-dash")).toThrow();
  });

  it("accepts kebab-case / uuid-ish ids", () => {
    expect(() => pathsFor(root, "agent-9f8e7d6c-1234-4abc-8def-0123456789ab")).not.toThrow();
    expect(() => pathsFor(root, "agent_underscore")).not.toThrow();
    expect(() => pathsFor(root, "Agent123")).not.toThrow();
  });
});

describe("serializeAgentMeta / deserializeAgentMeta", () => {
  it("round-trips a meta record through canonical JSON", () => {
    const meta = metaFixture();
    const text = serializeAgentMeta(meta);
    const parsed = deserializeAgentMeta(text);
    expect(parsed).toEqual(meta);
  });

  it("emits stable, pretty-printed JSON with a trailing newline (git-friendly)", () => {
    const text = serializeAgentMeta(metaFixture());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "agentId":');
    // Deterministic: same input → same bytes.
    expect(serializeAgentMeta(metaFixture())).toBe(text);
  });

  it("returns undefined on malformed JSON, wrong shape, or wrong version", () => {
    expect(deserializeAgentMeta("not json")).toBeUndefined();
    expect(deserializeAgentMeta("{}")).toBeUndefined();
    expect(deserializeAgentMeta(JSON.stringify({ ...metaFixture(), version: 2 }))).toBeUndefined();
    expect(deserializeAgentMeta(JSON.stringify({ ...metaFixture(), agentId: "" }))).toBeUndefined();
  });
});

describe("createLocalFirstAgentStore — save / load round-trip", () => {
  it("persists meta.json under the agent dir and loads it back", () => {
    const store = createLocalFirstAgentStore({ root });
    const meta = metaFixture({ agentId: "agent-persist-1" });
    store.saveMeta(meta);

    const expectedFile = join(root, "agents", "agent-persist-1", "meta.json");
    expect(existsSync(expectedFile)).toBe(true);
    expect(store.loadMeta("agent-persist-1")).toEqual(meta);
  });

  it("creates the blocks/ directory alongside meta.json", () => {
    const store = createLocalFirstAgentStore({ root });
    store.saveMeta(metaFixture({ agentId: "agent-blocks-1" }));
    expect(existsSync(join(root, "agents", "agent-blocks-1", "blocks"))).toBe(true);
  });

  it("loadMeta returns undefined for a missing agent", () => {
    const store = createLocalFirstAgentStore({ root });
    expect(store.loadMeta("agent-missing")).toBeUndefined();
  });

  it("loadMeta returns undefined on a corrupt meta file (skip-and-report, never throws)", () => {
    const store = createLocalFirstAgentStore({ root });
    const agentDir = join(root, "agents", "agent-corrupt");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "meta.json"), "{corrupt", "utf8");
    expect(store.loadMeta("agent-corrupt")).toBeUndefined();
  });

  it("listAgents returns saved agent ids, sorted, skipping corrupt entries", () => {
    const store = createLocalFirstAgentStore({ root });
    store.saveMeta(metaFixture({ agentId: "agent-b" }));
    store.saveMeta(metaFixture({ agentId: "agent-a" }));
    const corrupt = join(root, "agents", "agent-corrupt");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "meta.json"), "garbage", "utf8");
    expect(store.listAgents()).toEqual(["agent-a", "agent-b"]);
  });

  it("survives a store restart (new instance, same root)", () => {
    const first = createLocalFirstAgentStore({ root });
    first.saveMeta(metaFixture({ agentId: "agent-restart" }));
    const second = createLocalFirstAgentStore({ root });
    expect(second.loadMeta("agent-restart")).toEqual(metaFixture({ agentId: "agent-restart" }));
  });

  it("writes atomically — no .tmp litter remains after save", () => {
    const store = createLocalFirstAgentStore({ root });
    store.saveMeta(metaFixture({ agentId: "agent-atomic" }));
    const agentDir = join(root, "agents", "agent-atomic");
    const leftovers = existsSync(join(agentDir, "meta.json.tmp"));
    expect(leftovers).toBe(false);
    // Content is the canonical serialized form.
    expect(readFileSync(join(agentDir, "meta.json"), "utf8")).toBe(
      serializeAgentMeta(metaFixture({ agentId: "agent-atomic" }))
    );
  });

  it("rejects a traversal id on save/load (never escapes the root)", () => {
    const store = createLocalFirstAgentStore({ root });
    expect(() => store.saveMeta(metaFixture({ agentId: "../evil" }))).toThrow();
    expect(() => store.loadMeta("../evil")).toThrow();
  });
});
