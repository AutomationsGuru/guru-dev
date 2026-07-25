import { describe, expect, it } from "vitest";

import {
  createMemoryStoreBackend,
  type MemoryStoreBackend
} from '../../src/memory/storeBackendPluggable.js';

describe("store backend pluggable — memory map implementation", () => {
  it("get on a missing key returns undefined", () => {
    const backend: MemoryStoreBackend = createMemoryStoreBackend();
    expect(backend.get("absent")).toBeUndefined();
  });

  it("set then get round-trips the value", () => {
    const backend = createMemoryStoreBackend();
    backend.set("key", "value");
    expect(backend.get("key")).toBe("value");
  });

  it("set overwrites an existing key", () => {
    const backend = createMemoryStoreBackend();
    backend.set("key", "first");
    backend.set("key", "second");
    expect(backend.get("key")).toBe("second");
  });

  it("delete removes the key and reports true", () => {
    const backend = createMemoryStoreBackend();
    backend.set("key", "value");
    expect(backend.delete("key")).toBe(true);
    expect(backend.get("key")).toBeUndefined();
  });

  it("delete on a missing key reports false", () => {
    const backend = createMemoryStoreBackend();
    expect(backend.delete("absent")).toBe(false);
  });

  it("keys are isolated between backend instances", () => {
    const first = createMemoryStoreBackend();
    const second = createMemoryStoreBackend();
    first.set("key", "only-in-first");
    expect(second.get("key")).toBeUndefined();
  });

  it("accepts a seed map and copies it (mutating the seed does not leak in)", () => {
    const seed = new Map<string, string>([["seeded", "initial"]]);
    const backend = createMemoryStoreBackend(seed);
    expect(backend.get("seeded")).toBe("initial");
    seed.set("seeded", "mutated");
    seed.set("late", "nope");
    expect(backend.get("seeded")).toBe("initial");
    expect(backend.get("late")).toBeUndefined();
  });
});
