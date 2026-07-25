import { describe, expect, it } from "vitest";

import { createLazySymbolIndex } from '../../src/codeintel/lazySymbolIndex.js';
import type { SymbolRecord } from '../../src/codeintel/lazySymbolIndex.js';

function sym(
  path: string,
  name: string,
  kind: SymbolRecord["kind"] = "function"
): SymbolRecord {
  return { path, name, kind };
}

describe("createLazySymbolIndex", () => {
  it("hit (exact name): queryByName returns matching records", () => {
    const index = createLazySymbolIndex();
    const a = index.upsert(sym("src/a.ts", "parseConfig", "function"));
    const b = index.upsert(sym("src/b.ts", "loadConfig", "function"));

    expect(a).toEqual(sym("src/a.ts", "parseConfig", "function"));
    expect(index.queryByName("parseConfig")).toEqual([a]);
    expect(index.queryByName("loadConfig")).toEqual([b]);
    expect(index.size()).toBe(2);
  });

  it("miss (exact name): queryByName for absent name returns []", () => {
    const index = createLazySymbolIndex([sym("src/a.ts", "parseConfig")]);

    expect(index.queryByName("missing")).toEqual([]);
    expect(index.queryByName("parseconfig")).toEqual([]); // case-sensitive
    expect(index.queryByName("ParseConfig")).toEqual([]);
  });

  it("prefix hit: queryByPrefix returns names starting with prefix", () => {
    const index = createLazySymbolIndex();
    index.upsert(sym("src/a.ts", "parseConfig"));
    index.upsert(sym("src/b.ts", "parseJson"));
    index.upsert(sym("src/c.ts", "loadConfig"));

    expect(index.queryByPrefix("parse")).toEqual([
      sym("src/a.ts", "parseConfig"),
      sym("src/b.ts", "parseJson")
    ]);
  });

  it("prefix miss: queryByPrefix for non-matching prefix returns []", () => {
    const index = createLazySymbolIndex([
      sym("src/a.ts", "parseConfig"),
      sym("src/b.ts", "loadConfig")
    ]);

    expect(index.queryByPrefix("missing")).toEqual([]);
    expect(index.queryByPrefix("Parse")).toEqual([]); // case-sensitive
  });

  it("upsert replaces kind for same path+name", () => {
    const index = createLazySymbolIndex();
    index.upsert(sym("src/a.ts", "Widget", "class"));
    const replaced = index.upsert(sym("src/a.ts", "Widget", "interface"));

    expect(replaced).toEqual(sym("src/a.ts", "Widget", "interface"));
    expect(index.size()).toBe(1);
    expect(index.queryByName("Widget")).toEqual([
      sym("src/a.ts", "Widget", "interface")
    ]);
  });

  it("same name different paths: both returned by queryByName", () => {
    const index = createLazySymbolIndex();
    index.upsert(sym("src/a.ts", "helper", "function"));
    index.upsert(sym("src/b.ts", "helper", "method"));

    expect(index.size()).toBe(2);
    expect(index.queryByName("helper")).toEqual([
      sym("src/a.ts", "helper", "function"),
      sym("src/b.ts", "helper", "method")
    ]);
  });

  it("stable order: results sorted by name then path", () => {
    const index = createLazySymbolIndex();
    // Insert out of order
    index.upsert(sym("src/z.ts", "beta"));
    index.upsert(sym("src/a.ts", "alpha"));
    index.upsert(sym("src/m.ts", "beta"));
    index.upsert(sym("src/b.ts", "alpha"));

    expect(index.queryByPrefix("")).toEqual([
      sym("src/a.ts", "alpha"),
      sym("src/b.ts", "alpha"),
      sym("src/m.ts", "beta"),
      sym("src/z.ts", "beta")
    ]);

    expect(index.queryByName("beta")).toEqual([
      sym("src/m.ts", "beta"),
      sym("src/z.ts", "beta")
    ]);

    expect(index.queryByPrefix("a")).toEqual([
      sym("src/a.ts", "alpha"),
      sym("src/b.ts", "alpha")
    ]);
  });

  it("initial seed: createLazySymbolIndex([...]) seeds size and query", () => {
    const seed: readonly SymbolRecord[] = [
      sym("src/a.ts", "Foo", "class"),
      sym("src/b.ts", "bar", "function")
    ];
    const index = createLazySymbolIndex(seed);

    expect(index.size()).toBe(2);
    expect(index.queryByName("Foo")).toEqual([sym("src/a.ts", "Foo", "class")]);
    expect(index.queryByName("bar")).toEqual([
      sym("src/b.ts", "bar", "function")
    ]);
    expect(index.queryByPrefix("F")).toEqual([sym("src/a.ts", "Foo", "class")]);
  });

  it("clear: size becomes 0 and queries miss", () => {
    const index = createLazySymbolIndex([
      sym("src/a.ts", "parseConfig"),
      sym("src/b.ts", "loadConfig")
    ]);
    expect(index.size()).toBe(2);

    index.clear();

    expect(index.size()).toBe(0);
    expect(index.queryByName("parseConfig")).toEqual([]);
    expect(index.queryByPrefix("parse")).toEqual([]);
    expect(index.queryByPrefix("")).toEqual([]);
  });

  it("invalid input: empty path and empty name throw", () => {
    const index = createLazySymbolIndex();

    expect(() => index.upsert(sym("", "name"))).toThrow();
    expect(() => index.upsert(sym("src/a.ts", ""))).toThrow();
    expect(() => index.upsert(sym("", ""))).toThrow();
  });
});
