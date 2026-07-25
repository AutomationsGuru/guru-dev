import { describe, expect, it } from "vitest";

import {
  ToolScratchpadStore,
  formatToolScratchPointer,
  isToolScratchRef,
  measureToolResultBytes
} from '../../src/memory/toolScratchpad.js';

describe("measureToolResultBytes", () => {
  it("counts UTF-8 multi-byte characters by byte length, not char length", () => {
    // "é" is 2 bytes in UTF-8; "你" is 3 bytes.
    expect(measureToolResultBytes("é")).toBe(2);
    expect(measureToolResultBytes("你")).toBe(3);
    expect(measureToolResultBytes("hello")).toBe(5);
    expect(measureToolResultBytes("")).toBe(0);
    expect(measureToolResultBytes("café")).toBe(5); // c a f é = 1+1+1+2
    expect(measureToolResultBytes("a😀b")).toBe(6); // a(1) + 😀(4) + b(1)
  });
});

describe("formatToolScratchPointer", () => {
  it("formats the exact pointer string", () => {
    expect(formatToolScratchPointer("scratch:tool:abc", 42)).toBe(
      "[tool-scratchpad ref=scratch:tool:abc bytes=42]"
    );
    expect(formatToolScratchPointer("scratch:tool:x", 0)).toBe(
      "[tool-scratchpad ref=scratch:tool:x bytes=0]"
    );
  });
});

describe("isToolScratchRef", () => {
  it("accepts valid scratch:tool refs and rejects invalid ones", () => {
    expect(isToolScratchRef("scratch:tool:abc")).toBe(true);
    expect(isToolScratchRef("scratch:tool:1")).toBe(true);
    expect(isToolScratchRef("scratch:tool:id-with-dashes")).toBe(true);
    expect(isToolScratchRef("scratch:tool:uuid_like_value")).toBe(true);

    expect(isToolScratchRef("")).toBe(false);
    expect(isToolScratchRef("scratch:tool:")).toBe(false);
    expect(isToolScratchRef("scratch:tool:has space")).toBe(false);
    expect(isToolScratchRef("scratch:tool:has:colon")).toBe(false);
    expect(isToolScratchRef("scratch:memory:abc")).toBe(false);
    expect(isToolScratchRef("tool:scratch:abc")).toBe(false);
    expect(isToolScratchRef("scratch:tool")).toBe(false);
    expect(isToolScratchRef("not-a-ref")).toBe(false);
  });
});

describe("ToolScratchpadStore", () => {
  it("keeps results under threshold inline and leaves size at 0", () => {
    const store = new ToolScratchpadStore();
    const body = "small";
    const bytes = measureToolResultBytes(body);
    const parked = store.park(body, bytes + 1);

    expect(parked.parked).toBe(false);
    if (parked.parked) throw new Error("expected inline");
    expect(parked.result).toBe(body);
    expect(parked.bytes).toBe(bytes);
    expect(store.size).toBe(0);
  });

  it("parks results over threshold and returns ref+pointer with size 1", () => {
    const store = new ToolScratchpadStore({ createId: () => "park-1" });
    const body = "this is a large tool result body";
    const bytes = measureToolResultBytes(body);
    const parked = store.park(body, bytes - 1);

    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("expected stored");
    expect(parked.ref).toBe("scratch:tool:park-1");
    expect(parked.pointer).toBe(formatToolScratchPointer(parked.ref, bytes));
    expect(parked.bytes).toBe(bytes);
    expect(store.size).toBe(1);
  });

  it("resolve returns the exact parked body", () => {
    const store = new ToolScratchpadStore({ createId: () => "exact-body" });
    const body = "exact parked payload\nwith newlines\nand unicode: 你好";
    const parked = store.park(body, 0);

    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("expected stored");
    expect(store.resolve(parked.ref)).toBe(body);
  });

  it("parked result has no result property", () => {
    const store = new ToolScratchpadStore({ createId: () => "no-result" });
    const parked = store.park("payload large enough", 0);

    expect(parked.parked).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(parked, "result")).toBe(false);
    expect("result" in parked).toBe(false);
  });

  it("threshold 0: empty string stays inline, non-empty parks", () => {
    const store = new ToolScratchpadStore({ createId: () => "thresh-0" });

    const empty = store.park("", 0);
    expect(empty.parked).toBe(false);
    if (empty.parked) throw new Error("expected inline");
    expect(empty.result).toBe("");
    expect(empty.bytes).toBe(0);
    expect(store.size).toBe(0);

    const nonEmpty = store.park("x", 0);
    expect(nonEmpty.parked).toBe(true);
    if (!nonEmpty.parked) throw new Error("expected stored");
    expect(nonEmpty.ref).toBe("scratch:tool:thresh-0");
    expect(store.size).toBe(1);
  });

  it("bytes equal to threshold stay inline (strict greater-than)", () => {
    const store = new ToolScratchpadStore();
    const body = "abcd";
    const bytes = measureToolResultBytes(body);
    const parked = store.park(body, bytes);

    expect(parked.parked).toBe(false);
    if (parked.parked) throw new Error("expected inline");
    expect(parked.result).toBe(body);
    expect(parked.bytes).toBe(bytes);
    expect(store.size).toBe(0);
  });

  it("negative threshold parks even an empty string", () => {
    const store = new ToolScratchpadStore({ createId: () => "neg" });
    const parked = store.park("", -1);

    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("expected stored");
    expect(parked.ref).toBe("scratch:tool:neg");
    expect(parked.bytes).toBe(0);
    expect(store.resolve(parked.ref)).toBe("");
    expect(store.size).toBe(1);
  });

  it("non-finite threshold throws an Error matching /threshold/", () => {
    const store = new ToolScratchpadStore();

    expect(() => store.park("x", Number.NaN)).toThrow(/threshold/);
    expect(() => store.park("x", Number.POSITIVE_INFINITY)).toThrow(/threshold/);
    expect(() => store.park("x", Number.NEGATIVE_INFINITY)).toThrow(/threshold/);
    expect(store.size).toBe(0);
  });

  it("assigns unique refs for successive parks", () => {
    let n = 0;
    const store = new ToolScratchpadStore({ createId: () => `id-${++n}` });

    const a = store.park("first-payload", 0);
    const b = store.park("second-payload", 0);

    expect(a.parked && b.parked).toBe(true);
    if (!a.parked || !b.parked) throw new Error("expected both stored");
    expect(a.ref).toBe("scratch:tool:id-1");
    expect(b.ref).toBe("scratch:tool:id-2");
    expect(a.ref).not.toBe(b.ref);
    expect(store.size).toBe(2);
    expect(store.resolve(a.ref)).toBe("first-payload");
    expect(store.resolve(b.ref)).toBe("second-payload");
  });

  it("uses the injected createId for deterministic refs", () => {
    const store = new ToolScratchpadStore({ createId: () => "deterministic-xyz" });
    const parked = store.park("body", 0);

    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("expected stored");
    expect(parked.ref).toBe("scratch:tool:deterministic-xyz");
    expect(isToolScratchRef(parked.ref)).toBe(true);
    expect(parked.pointer).toBe(
      "[tool-scratchpad ref=scratch:tool:deterministic-xyz bytes=4]"
    );
  });

  it("resolve returns undefined for unknown refs", () => {
    const store = new ToolScratchpadStore();
    expect(store.resolve("scratch:tool:missing")).toBeUndefined();
    expect(store.resolve("scratch:tool:never-parked")).toBeUndefined();
  });

  it("delete returns true then false", () => {
    const store = new ToolScratchpadStore({ createId: () => "del-me" });
    const parked = store.park("to-delete", 0);
    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("expected stored");

    expect(store.delete(parked.ref)).toBe(true);
    expect(store.size).toBe(0);
    expect(store.resolve(parked.ref)).toBeUndefined();
    expect(store.delete(parked.ref)).toBe(false);
    expect(store.delete("scratch:tool:never-existed")).toBe(false);
  });

  it("clear empties the store", () => {
    let n = 0;
    const store = new ToolScratchpadStore({ createId: () => `c-${++n}` });
    store.park("one", 0);
    store.park("two", 0);
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.resolve("scratch:tool:c-1")).toBeUndefined();
    expect(store.resolve("scratch:tool:c-2")).toBeUndefined();
    expect(store.has("scratch:tool:c-1")).toBe(false);
  });

  it("has reports membership correctly", () => {
    const store = new ToolScratchpadStore({ createId: () => "member" });
    const ref = "scratch:tool:member";

    expect(store.has(ref)).toBe(false);
    const parked = store.park("membership-body", 0);
    expect(parked.parked).toBe(true);
    expect(store.has(ref)).toBe(true);

    store.delete(ref);
    expect(store.has(ref)).toBe(false);
  });

  it("multi-byte content crosses a threshold that character-length would miss", () => {
    // "你好" is 2 chars but 6 UTF-8 bytes. Threshold 3 would keep it inline
    // if measured by char length (2 <= 3) but must park by byte length (6 > 3).
    const store = new ToolScratchpadStore({ createId: () => "multibyte" });
    const body = "你好";
    expect(body.length).toBe(2);
    expect(measureToolResultBytes(body)).toBe(6);

    const parked = store.park(body, 3);
    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("expected stored by byte threshold");
    expect(parked.bytes).toBe(6);
    expect(parked.ref).toBe("scratch:tool:multibyte");
    expect(store.resolve(parked.ref)).toBe(body);
    expect(store.size).toBe(1);
  });
});
