import { describe, expect, it } from "vitest";

import { formatView, summarizeBlocks, type PalaceBlockLine } from '../../src/memory/palaceMemoryView.js';
import type { MemoryFactEntry } from '../../src/memory/policy.js';
import type { MemoryFact } from '../../src/memory/schemas.js';

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    name: "sample-fact",
    title: "Sample fact",
    description: "A sample fact for the palace view.",
    type: "project",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    confidence: 1,
    ...overrides
  };
}

function makeEntry(overrides: Partial<MemoryFact> = {}, body = "Body text."): MemoryFactEntry {
  return { fact: makeFact(overrides), body };
}

describe("palace memory view — empty", () => {
  it("empty block list yields an explicit empty summary", () => {
    const view = formatView([]);
    expect(view).toContain("0 memory block");
    expect(view).toContain("0 B");
  });

  it("empty block list summarizes to zero counts", () => {
    const summary = summarizeBlocks([]);
    expect(summary.blockCount).toBe(0);
    expect(summary.totalBodyBytes).toBe(0);
    expect(summary.lines).toEqual([]);
  });
});

describe("palace memory view — multi-block", () => {
  it("formats one line per block with label, size, and updatedAt", () => {
    const entries = [
      makeEntry(
        { name: "alpha", title: "Alpha", type: "project", updatedAt: "2026-07-19T08:00:00.000Z" },
        "alpha body"
      ),
      makeEntry(
        { name: "beta", title: "Beta", type: "user", updatedAt: "2026-07-18T08:00:00.000Z" },
        "beta body is longer"
      )
    ];
    const view = formatView(entries);
    const lines = view.split("\n");

    // Header reports count and total body bytes.
    expect(lines[0]).toContain("2 memory block");
    const expectedTotal = "alpha body".length + "beta body is longer".length;
    expect(lines[0]).toContain(`${expectedTotal} B`);

    // One line per block, each carrying the type label, title, size, updatedAt.
    const blockLines = lines.filter((line) => line.startsWith("- "));
    expect(blockLines).toHaveLength(2);
    expect(blockLines[0]).toContain("[project]");
    expect(blockLines[0]).toContain("Alpha");
    expect(blockLines[0]).toContain(`${"alpha body".length} B`);
    expect(blockLines[0]).toContain("2026-07-19T08:00:00.000Z");
    expect(blockLines[1]).toContain("[user]");
    expect(blockLines[1]).toContain("Beta");
    expect(blockLines[1]).toContain(`${"beta body is longer".length} B`);
    expect(blockLines[1]).toContain("2026-07-18T08:00:00.000Z");
  });

  it("preserves caller order (recency is the caller's concern)", () => {
    const entries = [
      makeEntry({ name: "older", title: "Older", updatedAt: "2026-07-01T00:00:00.000Z" }),
      makeEntry({ name: "newer", title: "Newer", updatedAt: "2026-07-20T00:00:00.000Z" })
    ];
    const view = formatView(entries);
    expect(view.indexOf("Older")).toBeLessThan(view.indexOf("Newer"));
  });

  it("summarizeBlocks returns structured lines matching the formatted view", () => {
    const entries = [makeEntry({ name: "gamma", title: "Gamma", type: "learning" }, "g")];
    const summary = summarizeBlocks(entries);
    expect(summary.blockCount).toBe(1);
    expect(summary.totalBodyBytes).toBe(1);
    expect(summary.lines).toHaveLength(1);
    const line: PalaceBlockLine = summary.lines[0]!;
    expect(line.name).toBe("gamma");
    expect(line.title).toBe("Gamma");
    expect(line.type).toBe("learning");
    expect(line.bodyBytes).toBe(1);
    expect(line.updatedAt).toBe("2026-07-15T12:00:00.000Z");
  });

  it("measures multi-byte bodies in bytes, not characters", () => {
    const entries = [makeEntry({ name: "unicode", title: "Unicode" }, "héllo")];
    const summary = summarizeBlocks(entries);
    expect(summary.totalBodyBytes).toBe(Buffer.byteLength("héllo", "utf8"));
  });
});
