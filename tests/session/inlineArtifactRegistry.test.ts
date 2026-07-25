import { describe, expect, it } from "vitest";

import {
  InMemoryInlineArtifactRegistry,
  createInlineArtifactRegistry,
  type InlineArtifactInput
} from '../../src/session/inlineArtifactRegistry.js';

function input(over: Partial<InlineArtifactInput> & Pick<InlineArtifactInput, "id">): InlineArtifactInput {
  return {
    stepId: "step-1",
    mime: "image/png",
    path: "artifacts/a.png",
    ...over
  } as InlineArtifactInput;
}

describe("inlineArtifactRegistry — construction", () => {
  it("starts empty", () => {
    const reg = createInlineArtifactRegistry();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
    expect(reg.listByStep("step-1")).toEqual([]);
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.has("missing")).toBe(false);
  });

  it("exposes the same surface from the class and the factory", () => {
    const fromFactory = createInlineArtifactRegistry();
    const fromClass = new InMemoryInlineArtifactRegistry();
    expect(fromFactory.put(input({ id: "x" })).id).toBe("x");
    expect(fromClass.put(input({ id: "x" })).id).toBe("x");
    expect(fromFactory.size).toBe(1);
    expect(fromClass.size).toBe(1);
  });
});

describe("inlineArtifactRegistry — put / get", () => {
  it("stores and returns a canonical record with a registry-assigned sequence", () => {
    const reg = createInlineArtifactRegistry();
    const stored = reg.put(input({ id: "a", label: "first" }));
    expect(stored).toMatchObject({
      id: "a",
      stepId: "step-1",
      mime: "image/png",
      path: "artifacts/a.png",
      label: "first",
      sequence: 0
    });
    expect(reg.get("a")).toBe(stored);
    expect(reg.has("a")).toBe(true);
    expect(reg.size).toBe(1);
  });

  it("rejects malformed input via the strict zod schema", () => {
    const reg = createInlineArtifactRegistry();
    // Empty required strings are invalid.
    expect(() => reg.put(input({ id: "", path: "p" }))).toThrow();
    expect(() => reg.put(input({ id: "a", mime: "" }))).toThrow();
    expect(() => reg.put(input({ id: "a", stepId: "   " }))).toThrow();
    // Whitespace-only is normalized to empty by trim → fails min(1).
    expect(() => reg.put(input({ id: "   " }))).toThrow();
    // Unknown keys are rejected (.strict()).
    expect(() => reg.put({ ...input({ id: "a" }), bogus: true } as never)).toThrow();
    // The registry stayed clean after failed puts.
    expect(reg.size).toBe(0);
  });

  it("stores records across multiple steps", () => {
    const reg = createInlineArtifactRegistry();
    reg.put(input({ id: "a", stepId: "step-1" }));
    reg.put(input({ id: "b", stepId: "step-2", mime: "text/markdown", path: "out/m.md" }));
    reg.put(input({ id: "c", stepId: "step-1", mime: "application/json", path: "out/d.json" }));
    expect(reg.size).toBe(3);
    expect(reg.list().map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("inlineArtifactRegistry — duplicate id overwrite", () => {
  it("overwrites the prior record when put is called with an existing id", () => {
    const reg = createInlineArtifactRegistry();
    reg.put(input({ id: "a", mime: "image/png", path: "old.png", label: "v1" }));
    const overwritten = reg.put(input({ id: "a", mime: "image/webp", path: "new.webp", label: "v2" }));

    // Size did not grow: still exactly one record for id "a".
    expect(reg.size).toBe(1);
    // The stored payload is the new one.
    expect(overwritten).toMatchObject({ id: "a", mime: "image/webp", path: "new.webp", label: "v2" });
    expect(reg.get("a")).toMatchObject({ mime: "image/webp", path: "new.webp", label: "v2" });
    // The old payload is gone.
    expect(reg.get("a")?.mime).not.toBe("image/png");
  });

  it("preserves the original insertion sequence on overwrite so list order is stable", () => {
    const reg = createInlineArtifactRegistry();
    reg.put(input({ id: "a", stepId: "s1" }));
    reg.put(input({ id: "b", stepId: "s1" }));
    reg.put(input({ id: "c", stepId: "s1" }));
    // Overwrite the middle id after others exist.
    const overwritten = reg.put(input({ id: "b", stepId: "s1", mime: "text/plain", path: "b.txt" }));

    expect(overwritten.sequence).toBe(1); // original slot retained
    // Order is unchanged: a, b, c — b did not jump to the end.
    expect(reg.list().map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(reg.list().map((r) => r.sequence)).toEqual([0, 1, 2]);
    // And the overwritten payload is reflected in the ordered list.
    const middle = reg.list()[1];
    expect(middle).toMatchObject({ id: "b", mime: "text/plain", path: "b.txt" });
  });

  it("reflects an overwritten record's new stepId in listByStep", () => {
    const reg = createInlineArtifactRegistry();
    reg.put(input({ id: "a", stepId: "s1", path: "p1" }));
    reg.put(input({ id: "a", stepId: "s2", path: "p2" }));

    expect(reg.listByStep("s1")).toEqual([]);
    expect(reg.listByStep("s2").map((r) => r.path)).toEqual(["p2"]);
    expect(reg.size).toBe(1);
  });

  it("treats overwrites as non-destructive to the registry: clear resets fully", () => {
    const reg = createInlineArtifactRegistry();
    reg.put(input({ id: "a" }));
    reg.put(input({ id: "a", path: "other" }));
    reg.put(input({ id: "b" }));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
    expect(reg.get("a")).toBeUndefined();
    // Sequence counter restarts after clear, so a fresh put gets sequence 0.
    expect(reg.put(input({ id: "z" })).sequence).toBe(0);
  });
});

describe("inlineArtifactRegistry — listByStep ordering", () => {
  it("returns only the requested step's records in insertion order", () => {
    const reg = createInlineArtifactRegistry();
    reg.put(input({ id: "a", stepId: "s1" }));
    reg.put(input({ id: "b", stepId: "s2" }));
    reg.put(input({ id: "c", stepId: "s1" }));
    reg.put(input({ id: "d", stepId: "s2" }));
    reg.put(input({ id: "e", stepId: "s1" }));

    expect(reg.listByStep("s1").map((r) => r.id)).toEqual(["a", "c", "e"]);
    expect(reg.listByStep("s2").map((r) => r.id)).toEqual(["b", "d"]);
    expect(reg.listByStep("absent")).toEqual([]);
  });
});

describe("inlineArtifactRegistry — pure-metadata guarantee", () => {
  it("treats path as opaque metadata and never resolves it to disk", () => {
    const reg = createInlineArtifactRegistry();
    // A path that does not exist anywhere is stored verbatim; the registry must
    // not stat, read, create, or move anything for it.
    const stored = reg.put(input({ id: "ghost", path: "/definitely/does/not/exist/ghost.png" }));
    expect(stored.path).toBe("/definitely/does/not/exist/ghost.png");
    expect(reg.get("ghost")?.path).toBe("/definitely/does/not/exist/ghost.png");
    // Removing the record is an in-memory clear only; no file is touched.
    reg.clear();
    expect(reg.get("ghost")).toBeUndefined();
  });
});
