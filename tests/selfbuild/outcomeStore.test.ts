import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTaskOutcomeStore, type TaskOutcomeStore } from '../../src/selfbuild/outcomeStore.js';
import type { LearnedFact } from '../../src/selfbuild/learn.js';

function store(cwd: string): TaskOutcomeStore {
  return createTaskOutcomeStore(cwd);
}

function shipped(id: string): LearnedFact {
  return { taskId: id, outcome: "shipped", verdict: "GREEN", confidence: "validated", fact: `task ${id} completed` };
}

function blocked(id: string, note?: string): LearnedFact {
  return { taskId: id, outcome: "blocked", verdict: "RED", confidence: "parked", fact: `task ${id} blocked`, blockerNote: note ?? "unknown" };
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "guru-outcomeStore-test-"));
  return dir;
}

describe("createTaskOutcomeStore (hardening #12)", () => {
  it("returns empty history when no store file exists", async () => {
    const cwd = tempCwd();
    try {
      const s = store(cwd);
      const history = await s.load();
      expect(history.completed.size).toBe(0);
      expect(history.recentBlockers.size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("recordFact('shipped') adds to completed", async () => {
    const cwd = tempCwd();
    try {
      const s = store(cwd);
      await s.load();
      s.recordFact(shipped("task-a"));
      const after = await s.load(); // re-read from fresh in-memory; recordFact is in-memory only
      // recordFact updates in-memory — verify via flush + re-load
      await s.flush();
      const history = await store(cwd).load();
      expect(history.completed.has("task-a")).toBe(true);
      expect(history.recentBlockers.size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("recordFact('blocked') adds to recentBlockers", async () => {
    const cwd = tempCwd();
    try {
      const s = store(cwd);
      await s.load();
      s.recordFact(blocked("task-b", "review failed"));
      await s.flush();
      const history = await store(cwd).load();
      expect(history.completed.size).toBe(0);
      expect(history.recentBlockers.has("task-b")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("flush writes valid JSON that load can restore", async () => {
    const cwd = tempCwd();
    try {
      const s = store(cwd);
      await s.load();
      s.recordFact(shipped("task-1"));
      s.recordFact(blocked("task-2"));
      s.recordFact(shipped("task-3"));
      await s.flush();

      // New store (new call) reads the same file — cross-invocation persistence.
      const restored = await store(cwd).load();
      expect(restored.completed.has("task-1")).toBe(true);
      expect(restored.completed.has("task-3")).toBe(true);
      expect(restored.recentBlockers.has("task-2")).toBe(true);
      expect(restored.completed.size).toBe(2);
      expect(restored.recentBlockers.size).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("load restores previous state (cross-invocation)", async () => {
    const cwd = tempCwd();
    try {
      // First invocation: ship task-x, block task-y
      let s = store(cwd);
      await s.load();
      s.recordFact(shipped("task-x"));
      s.recordFact(blocked("task-y", "build failed"));
      await s.flush();

      // Second invocation: a brand new store sees the persisted state
      s = store(cwd);
      const history = await s.load();
      expect(history.completed.has("task-x")).toBe(true);
      expect(history.recentBlockers.has("task-y")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("missing file returns empty set (no crash)", async () => {
    const cwd = tempCwd();
    try {
      // Do NOT create the .guru directory or file
      const s = store(cwd);
      const history = await s.load();
      expect(history.completed.size).toBe(0);
      expect(history.recentBlockers.size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("corrupt JSON returns empty set (no crash)", async () => {
    const cwd = tempCwd();
    try {
      // Manually write corrupt JSON
      const guruDir = join(cwd, ".guru");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(guruDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(guruDir, "task-outcomes.json"), "this is not json {{{", "utf8");

      const s = store(cwd);
      const history = await s.load();
      expect(history.completed.size).toBe(0);
      expect(history.recentBlockers.size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("wrong schema version returns empty set (no crash)", async () => {
    const cwd = tempCwd();
    try {
      const guruDir = join(cwd, ".guru");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(guruDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(guruDir, "task-outcomes.json"),
        JSON.stringify({ schemaVersion: 99, completed: ["x"], recentBlockers: [], updatedAt: "2026-01-01T00:00:00.000Z" }),
        "utf8"
      );

      const s = store(cwd);
      const history = await s.load();
      expect(history.completed.size).toBe(0);
      expect(history.recentBlockers.size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["completed", "recentBlockers"])("malformed %s array returns empty (no crash)", async (field) => {
    const cwd = tempCwd();
    try {
      const guruDir = join(cwd, ".guru");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(guruDir, { recursive: true, mode: 0o700 });
      const json: Record<string, unknown> = {
        schemaVersion: 1,
        completed: ["x"],
        recentBlockers: ["y"],
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      json[field] = "not-an-array";
      writeFileSync(join(guruDir, "task-outcomes.json"), JSON.stringify(json), "utf8");

      const s = store(cwd);
      const history = await s.load();
      expect(history.completed.size).toBe(0);
      expect(history.recentBlockers.size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("load seeds in-memory sets so re-load reflects accumulated state", async () => {
    const cwd = tempCwd();
    try {
      const s = store(cwd);
      // Load seeds in-memory from disk (empty initially)
      await s.load();
      s.recordFact(shipped("a"));
      s.recordFact(blocked("b"));

      // Re-load (without flushing) reads fresh from disk — the in-memory-only
      // facts are NOT persisted yet, so a fresh store sees nothing.
      const fresh = await store(cwd).load();
      expect(fresh.completed.size).toBe(0);
      expect(fresh.recentBlockers.size).toBe(0);

      // After flush, a fresh store sees the state.
      await s.flush();
      const after = await store(cwd).load();
      expect(after.completed.has("a")).toBe(true);
      expect(after.recentBlockers.has("b")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});