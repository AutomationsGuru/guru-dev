import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentIdentityMemory,
  hasHardLimitAnchor,
  type AgentIdentityMemory
} from '../../src/memory/agentIdentityMemory.js';
import {
  DEFAULT_HARD_LIMIT_ANCHOR_TEXT,
  HARD_LIMIT_ANCHOR_LABEL
} from '../../src/memory/agentIdentityMemorySchema.js';

const cleanups: string[] = [];

function makeMemory(now?: () => Date, agentId?: string): { memory: AgentIdentityMemory; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "guru-identity-test-"));
  cleanups.push(dir);
  const memory = createAgentIdentityMemory({
    directory: dir,
    ...(now ? { now } : {}),
    ...(agentId ? { agentId } : {})
  });
  return { memory, dir };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent identity memory — createAgent mints a durable id with the anchor", () => {
  it("creates an identity with a stable agentId and the protected hard-limit anchor first", () => {
    const fixedTime = new Date("2026-07-19T06:31:00.000Z");
    const { memory } = makeMemory(() => fixedTime, "agent-f174-test");
    const identity = memory.createAgent();

    expect(identity.agentId).toBe("agent-f174-test");
    expect(identity.version).toBe(1);
    expect(identity.createdAt).toBe("2026-07-19T06:31:00.000Z");
    expect(identity.updatedAt).toBe("2026-07-19T06:31:00.000Z");
    expect(identity.blocks[0]?.label).toBe(HARD_LIMIT_ANCHOR_LABEL);
    expect(identity.blocks[0]?.protected).toBe(true);
    expect(identity.blocks[0]?.text).toBe(DEFAULT_HARD_LIMIT_ANCHOR_TEXT);
    expect(hasHardLimitAnchor(identity.blocks)).toBe(true);
  });

  it("accepts initial blocks and dedupes, keeping the anchor first and protected", () => {
    const { memory } = makeMemory(undefined, "agent-dedupe");
    const identity = memory.createAgent([
      { label: "role", text: "build agent" },
      { label: "role", text: "duplicate label" },
      { label: HARD_LIMIT_ANCHOR_LABEL, text: "caller override of anchor text" }
    ]);

    const labels = identity.blocks.map((block) => block.label);
    expect(labels).toStrictEqual([HARD_LIMIT_ANCHOR_LABEL, "role"]);
    expect(memory.getBlock(identity, "role")?.text).toBe("build agent");
    expect(memory.getBlock(identity, HARD_LIMIT_ANCHOR_LABEL)?.text).toBe("caller override of anchor text");
    expect(memory.getBlock(identity, HARD_LIMIT_ANCHOR_LABEL)?.protected).toBe(true);
  });

  it("persists to disk on create and refuses to clobber an existing identity", () => {
    const { memory, dir } = makeMemory(undefined, "agent-persist");
    memory.createAgent([{ label: "role", text: "first" }]);
    expect(existsSync(join(dir, "agent-identity.json"))).toBe(true);

    expect(() => memory.createAgent()).toThrow(/already exists/u);
  });
});

describe("agent identity memory — serialize/load round trip (the acceptance core)", () => {
  it("a serialized identity reloads identical (cross-session survival)", () => {
    const { memory } = makeMemory(undefined, "agent-roundtrip");
    const identity = memory.createAgent([{ label: "role", text: "code reviewer" }, { label: "tone", text: "concise" }]);

    const text = memory.serialize(identity);
    const reloaded = memory.deserialize(text);

    expect(reloaded).toStrictEqual(identity);
  });

  it("a saved identity survives a fresh memory instance over the same directory", () => {
    const { memory, dir } = makeMemory(undefined, "agent-restart");
    const identity = memory.createAgent([{ label: "role", text: "ship reviewer" }]);
    const updated = memory.setBlock(identity, { label: "tone", text: "blunt" });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      memory.save(updated.identity); // persist the edited identity
    }

    // Simulate restart: brand-new memory over the same directory.
    const reborn = createAgentIdentityMemory({ directory: dir });
    const loaded = reborn.load();
    expect(loaded).toBeDefined();
    expect(loaded?.agentId).toBe("agent-restart");
    expect(reborn.getBlock(loaded!, "role")?.text).toBe("ship reviewer");
    expect(reborn.getBlock(loaded!, "tone")?.text).toBe("blunt");
    expect(hasHardLimitAnchor(loaded!.blocks)).toBe(true);
  });

  it("deserialize returns undefined for malformed JSON (skip-and-report, never throw)", () => {
    const { memory } = makeMemory(undefined, "agent-malformed");
    expect(memory.deserialize("{ not json")).toBeUndefined();
    expect(memory.deserialize('{"agentId":"x"}')).toBeUndefined(); // fails schema
    expect(memory.deserialize("null")).toBeUndefined();
  });

  it("load returns undefined when no identity file exists (cold boot)", () => {
    const { memory } = makeMemory(undefined, "agent-cold");
    expect(memory.load()).toBeUndefined();
  });

  it("load returns undefined for a corrupt on-disk file instead of throwing", () => {
    const { memory, dir } = makeMemory(undefined, "agent-corrupt");
    writeFileSync(join(dir, "agent-identity.json"), "{ broken", "utf8");
    expect(memory.load()).toBeUndefined();
  });
});

describe("agent identity memory — setBlock / getBlock / getBlocks", () => {
  it("setBlock adds a new block and updates updatedAt", () => {
    const before = new Date("2026-07-19T06:31:00.000Z");
    const after = new Date("2026-07-19T07:00:00.000Z");
    let clock = before;
    const { memory } = makeMemory(() => clock, "agent-set");
    const identity = memory.createAgent();

    clock = after;
    const result = memory.setBlock(identity, { label: "role", text: "builder" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.updatedAt).toBe("2026-07-19T07:00:00.000Z");
      expect(memory.getBlock(result.identity, "role")?.text).toBe("builder");
    }
  });

  it("setBlock replaces an existing block's text in place", () => {
    const { memory } = makeMemory(undefined, "agent-replace");
    const identity = memory.createAgent([{ label: "role", text: "old" }]);
    const result = memory.setBlock(identity, { label: "role", text: "new" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(memory.getBlock(result.identity, "role")?.text).toBe("new");
      expect(result.identity.blocks.filter((block) => block.label === "role")).toHaveLength(1);
    }
  });

  it("getBlocks returns every block (anchor first) and is a defensive copy", () => {
    const { memory } = makeMemory(undefined, "agent-list");
    const identity = memory.createAgent([{ label: "role", text: "x" }]);
    const blocks = memory.getBlocks(identity);
    expect(blocks.map((block) => block.label)).toStrictEqual([HARD_LIMIT_ANCHOR_LABEL, "role"]);
    blocks[0]!.text = "mutated";
    expect(memory.getBlock(identity, HARD_LIMIT_ANCHOR_LABEL)?.text).toBe(DEFAULT_HARD_LIMIT_ANCHOR_TEXT);
  });

  it("setBlock rejects invalid input with blocker kinds (never throws)", () => {
    const { memory } = makeMemory(undefined, "agent-invalid");
    const identity = memory.createAgent();
    const result = memory.setBlock(identity, { label: "Bad Label!", text: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.summary).toMatch(/validation/u);
    }
  });
});

describe("agent identity memory — the hard-limit anchor gate (the one that matters most)", () => {
  it("applyUpdate can edit the anchor's TEXT but it stays protected and present", () => {
    const { memory } = makeMemory(undefined, "agent-anchor-edit");
    const identity = memory.createAgent();
    const result = memory.applyUpdate(identity, [{ label: HARD_LIMIT_ANCHOR_LABEL, text: "rewritten anchor" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const anchor = memory.getBlock(result.identity, HARD_LIMIT_ANCHOR_LABEL);
      expect(anchor?.text).toBe("rewritten anchor");
      expect(anchor?.protected).toBe(true);
      expect(hasHardLimitAnchor(result.identity.blocks)).toBe(true);
    }
  });

  it("applyUpdate rejects an update that empties the anchor text (removing the marker)", () => {
    const { memory } = makeMemory(undefined, "agent-anchor-blank");
    const identity = memory.createAgent();
    // Bypass setBlock validation to simulate an adversarial empty-anchor edit.
    const tampered = {
      ...identity,
      blocks: [{ label: HARD_LIMIT_ANCHOR_LABEL, text: "   ", protected: true }]
    };
    const result = memory.applyUpdate(tampered, [{ label: "role", text: "benign" }]);
    // The gate runs over the post-update state; here the anchor is already blank,
    // so even a benign update is rejected because the gate sees a missing anchor.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain("hard-limit-anchor-removed");
    }
  });

  it("applyUpdate on a hand-tampered identity missing the anchor rejects (constitution holds)", () => {
    const { memory } = makeMemory(undefined, "agent-anchor-missing");
    const identity = memory.createAgent();
    const tampered: typeof identity = {
      ...identity,
      blocks: identity.blocks.filter((block) => block.label !== HARD_LIMIT_ANCHOR_LABEL)
    };
    expect(hasHardLimitAnchor(tampered.blocks)).toBe(false);
    const result = memory.applyUpdate(tampered, [{ label: "role", text: "anything" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain("hard-limit-anchor-removed");
      expect(result.summary).toMatch(/hard-limit anchor/u);
    }
  });

  it("round-trip through disk preserves the anchor protection (no silent downgrade)", () => {
    const { memory, dir } = makeMemory(undefined, "agent-anchor-disk");
    memory.createAgent();
    const raw = JSON.parse(readFileSync(join(dir, "agent-identity.json"), "utf8")) as { blocks: Array<{ label: string; protected: boolean }> };
    const anchor = raw.blocks.find((block) => block.label === HARD_LIMIT_ANCHOR_LABEL);
    expect(anchor?.protected).toBe(true);

    const loaded = memory.load();
    expect(loaded).toBeDefined();
    expect(hasHardLimitAnchor(loaded!.blocks)).toBe(true);
  });
});

describe("agent identity memory — mergeIntoSystemContext", () => {
  it("renders blocks into a system-context section with the anchor", () => {
    const { memory } = makeMemory(undefined, "agent-merge");
    const identity = memory.createAgent([{ label: "role", text: "code reviewer" }]);
    const block = memory.mergeIntoSystemContext(identity);
    expect(block).toContain("## Agent identity");
    expect(block).toContain(HARD_LIMIT_ANCHOR_LABEL);
    expect(block).toContain("(protected)");
    expect(block).toContain("code reviewer");
    expect(block).toContain(DEFAULT_HARD_LIMIT_ANCHOR_TEXT.split("\n")[0]!);
  });

  it("returns an empty string for an identity with no blocks", () => {
    const { memory } = makeMemory(undefined, "agent-merge-empty");
    // An identity always has the anchor on create, so construct a no-block record directly.
    const empty = { agentId: "x", version: 1 as const, createdAt: "t", updatedAt: "t", blocks: [] };
    expect(memory.mergeIntoSystemContext(empty)).toBe("");
  });
});
