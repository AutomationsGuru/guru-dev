import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVersionedMemoryStore,
  isValidVersionedKey,
  type VersionedMemoryStore
} from "../../src/memory/versionedMemoryStore.js";

const cleanups: string[] = [];

function makeStore(now?: () => Date): { store: VersionedMemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "guru-versioned-memory-test-"));
  cleanups.push(dir);
  const store = createVersionedMemoryStore({ directory: dir, ...(now ? { now } : {}) });
  return { store, dir };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("versioned memory store — put/getLatest/history (the acceptance core)", () => {
  it("put returns version 1 for a new key and increments on each subsequent put", () => {
    const { store } = makeStore();
    expect(store.put("alpha", { value: "v1" }).version).toBe(1);
    expect(store.put("alpha", { value: "v2" }).version).toBe(2);
    expect(store.put("alpha", { value: "v3" }).version).toBe(3);
  });

  it("versions increment independently per key", () => {
    const { store } = makeStore();
    store.put("alpha", { value: "a1" });
    store.put("beta", { value: "b1" });
    store.put("beta", { value: "b2" });
    expect(store.put("alpha", { value: "a2" }).version).toBe(2);
    expect(store.put("beta", { value: "b3" }).version).toBe(3);
  });

  it("getLatest returns the newest value and version", () => {
    const { store } = makeStore();
    store.put("alpha", { value: "v1" });
    store.put("alpha", { value: "v2" });
    store.put("alpha", { value: "v3" });
    const latest = store.getLatest("alpha");
    expect(latest).not.toBeNull();
    expect(latest?.key).toBe("alpha");
    expect(latest?.version).toBe(3);
    expect(latest?.value).toBe("v3");
  });

  it("getLatest returns null for a key with no versions", () => {
    const { store } = makeStore();
    expect(store.getLatest("never-put")).toBeNull();
  });

  it("history lists version ids in insertion order (oldest first)", () => {
    const { store } = makeStore();
    store.put("alpha", { value: "v1" });
    store.put("alpha", { value: "v2" });
    store.put("alpha", { value: "v3" });
    expect(store.history("alpha")).toEqual([1, 2, 3]);
    expect(store.count("alpha")).toBe(3);
  });

  it("history is empty for an unknown key", () => {
    const { store } = makeStore();
    expect(store.history("never-put")).toEqual([]);
    expect(store.count("never-put")).toBe(0);
  });
});

describe("versioned memory store — durability and isolation", () => {
  it("versions survive a fresh store instance over the same directory (restart survival)", () => {
    const { store, dir } = makeStore();
    store.put("alpha", { value: "v1" });
    store.put("alpha", { value: "v2" });

    const reborn = createVersionedMemoryStore({ directory: dir });
    expect(reborn.history("alpha")).toEqual([1, 2]);
    expect(reborn.getLatest("alpha")?.value).toBe("v2");
    // A put after restart continues the existing sequence, not from 1.
    expect(reborn.put("alpha", { value: "v3" }).version).toBe(3);
  });

  it("two keys are fully isolated on disk", () => {
    const { store } = makeStore();
    store.put("alpha", { value: "a1" });
    store.put("beta", { value: "b1" });
    expect(store.getLatest("alpha")?.value).toBe("a1");
    expect(store.getLatest("beta")?.value).toBe("b1");
    expect(store.history("alpha")).toEqual([1]);
    expect(store.history("beta")).toEqual([1]);
  });

  it("values may contain newlines and special characters without corrupting the trail", () => {
    const { store } = makeStore();
    const tricky = "line one\nline\ttwo\n\n{ \"json\": \"inside\" }";
    store.put("alpha", { value: tricky });
    store.put("alpha", { value: "plain" });
    expect(store.getLatest("alpha")?.value).toBe("plain");
    expect(store.history("alpha")).toEqual([1, 2]);
    // Restart and confirm the multiline first version is intact.
    const { dir } = { dir: store.directory } as { dir: string };
    const reborn = createVersionedMemoryStore({ directory: dir });
    // Latest is still the plain second version; the trail length survived.
    expect(reborn.history("alpha")).toEqual([1, 2]);
  });

  it("each write is atomic — no .tmp file is left behind", () => {
    const { store, dir } = makeStore();
    store.put("alpha", { value: "v1" });
    store.put("alpha", { value: "v2" });
    expect(existsSync(join(dir, "alpha.log.tmp"))).toBe(false);
    expect(existsSync(join(dir, "alpha.log"))).toBe(true);
  });

  it("storedAt uses the injected clock", () => {
    const fixed = new Date("2026-07-19T16:42:00.000Z");
    const { store } = makeStore(() => fixed);
    const result = store.put("alpha", { value: "v1" });
    expect(result.storedAt).toBe("2026-07-19T16:42:00.000Z");
    expect(store.getLatest("alpha")?.storedAt).toBe("2026-07-19T16:42:00.000Z");
  });
});

describe("versioned memory store — key safety (path-traversal gate)", () => {
  it("rejects path-unsafe keys before touching the filesystem", () => {
    const { store, dir } = makeStore();
    expect(() => store.put("../escape", { value: "x" })).toThrow();
    expect(() => store.put("a/b", { value: "x" })).toThrow();
    expect(() => store.put("a\\b", { value: "x" })).toThrow();
    expect(() => store.put("", { value: "x" })).toThrow();
    expect(() => store.put(".hidden", { value: "x" })).toThrow();
    // Nothing was written for any rejected key.
    expect(existsSync(join(dir, "../escape.log"))).toBe(false);
    expect(store.history("../escape")).toEqual([]);
  });

  it("isValidVersionedKey matches the store gate", () => {
    expect(isValidVersionedKey("alpha")).toBe(true);
    expect(isValidVersionedKey("provider-wiring")).toBe(true);
    expect(isValidVersionedKey("key.with.dots")).toBe(true);
    expect(isValidVersionedKey("")).toBe(false);
    expect(isValidVersionedKey("../x")).toBe(false);
    expect(isValidVersionedKey(".hidden")).toBe(false);
    expect(isValidVersionedKey("a b")).toBe(false);
  });
});
