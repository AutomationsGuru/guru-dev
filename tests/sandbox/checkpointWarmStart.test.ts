import { describe, expect, it } from "vitest";

import {
  CheckpointRecordSchema,
  CheckpointWarmStartError,
  type SandboxCheckpointRegistry,
  type SandboxRegistry,
  createCheckpoint,
  createRegistries,
  getBox,
  getCheckpoint,
  listCheckpoints,
  spawnFromCheckpoint,
} from '../../src/sandbox/checkpointWarmStart.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function freshRegistries(): {
  checkpoints: SandboxCheckpointRegistry;
  boxes: SandboxRegistry;
} {
  return createRegistries();
}

// ── createCheckpoint ─────────────────────────────────────────────────────────

describe("createCheckpoint", () => {
  it("records a checkpoint with a stable id and no parent", () => {
    const { checkpoints } = freshRegistries();
    const cp = createCheckpoint(checkpoints, "base");

    expect(cp.id).toBe("base");
    expect(cp.parentId).toBeNull();
    expect(getCheckpoint(checkpoints, "base")).toBe(cp);
    expect(CheckpointRecordSchema.parse(cp)).toEqual(cp);
  });

  it("rejects an empty checkpoint id", () => {
    const { checkpoints } = freshRegistries();
    expect(() => createCheckpoint(checkpoints, "")).toThrow(CheckpointWarmStartError);
  });

  it("rejects a duplicate checkpoint id", () => {
    const { checkpoints } = freshRegistries();
    createCheckpoint(checkpoints, "base");
    expect(() => createCheckpoint(checkpoints, "base")).toThrow(CheckpointWarmStartError);
  });

  it("accepts an explicit parent checkpoint and threads the lineage", () => {
    const { checkpoints } = freshRegistries();
    const base = createCheckpoint(checkpoints, "base");
    const child = createCheckpoint(checkpoints, "child", { parentId: "base" });

    expect(child.parentId).toBe("base");
    expect(getCheckpoint(checkpoints, "child")?.parentId).toBe("base");
    expect(base.parentId).toBeNull();
  });

  it("rejects a parent checkpoint that does not exist", () => {
    const { checkpoints } = freshRegistries();
    expect(() => createCheckpoint(checkpoints, "child", { parentId: "ghost" })).toThrow(
      CheckpointWarmStartError,
    );
  });
});

// ── spawnFromCheckpoint ──────────────────────────────────────────────────────

describe("spawnFromCheckpoint", () => {
  it("spawns a new box in 'created' status that references the parent snapshot", () => {
    const { checkpoints, boxes } = freshRegistries();
    const base = createCheckpoint(checkpoints, "base");

    const box = spawnFromCheckpoint(boxes, checkpoints, base.id, "box-1");

    expect(box.id).toBe("box-1");
    expect(box.status).toBe("created");
    expect(box.checkpointId).toBe("base");
    expect(getBox(boxes, "box-1")).toBe(box);
  });

  it("rejects spawning from an unknown checkpoint id", () => {
    const { checkpoints, boxes } = freshRegistries();
    expect(() => spawnFromCheckpoint(boxes, checkpoints, "ghost", "box-1")).toThrow(
      CheckpointWarmStartError,
    );
    expect(getBox(boxes, "box-1")).toBeUndefined();
  });

  it("rejects reusing an existing box id", () => {
    const { checkpoints, boxes } = freshRegistries();
    const base = createCheckpoint(checkpoints, "base");
    spawnFromCheckpoint(boxes, checkpoints, "base", "box-1");

    expect(() => spawnFromCheckpoint(boxes, checkpoints, "base", "box-1")).toThrow(
      CheckpointWarmStartError,
    );
  });

  it("two boxes from the same checkpoint share the base snapshot", () => {
    const { checkpoints, boxes } = freshRegistries();
    const base = createCheckpoint(checkpoints, "base");
    const a = spawnFromCheckpoint(boxes, checkpoints, "base", "box-a");
    const b = spawnFromCheckpoint(boxes, checkpoints, "base", "box-b");

    expect(a.checkpointId).toBe("base");
    expect(b.checkpointId).toBe("base");
    expect(a.checkpointId).toBe(b.checkpointId);
    expect(a.id).not.toBe(b.id);
  });
});

// ── listing ──────────────────────────────────────────────────────────────────

describe("listCheckpoints", () => {
  it("returns checkpoints in insertion order", () => {
    const { checkpoints } = freshRegistries();
    createCheckpoint(checkpoints, "base");
    const child = createCheckpoint(checkpoints, "child", { parentId: "base" });

    expect(listCheckpoints(checkpoints).map((c) => c.id)).toEqual(["base", "child"]);
    expect(listCheckpoints(checkpoints)[1]).toBe(child);
  });
});
