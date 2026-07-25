import { merge, type StateEntry } from "../../src/home/dualStateLaneSync.js";

function entry(overrides: Partial<StateEntry> = {}): StateEntry {
  return {
    kind: overrides.kind ?? "current",
    title: overrides.title ?? "Test state",
    body: overrides.body ?? "Default body content.",
    ...overrides
  };
}

describe("dualStateLaneSync", () => {
  describe("merge", () => {
    it("returns an empty merged set and no conflicts when both root and lane are empty", () => {
      const result = merge([], []);
      expect(result.merged).toEqual([]);
      expect(result.conflicts).toEqual([]);
    });

    it("preserves root-only entries when lane is empty", () => {
      const root = [entry({ kind: "current", title: "Root-only", body: "Root body." })];
      const result = merge(root, []);
      expect(result.merged).toEqual(root);
      expect(result.conflicts).toEqual([]);
    });

    it("preserves lane-only entries when root is empty", () => {
      const lane = [entry({ kind: "future", title: "Lane-only", body: "Lane body." })];
      const result = merge([], lane);
      expect(result.merged).toEqual(lane);
      expect(result.conflicts).toEqual([]);
    });

    it("merges non-overlapping root and lane entries without conflicts", () => {
      const root = [
        entry({ kind: "current", title: "Root entry", body: "Root body." })
      ];
      const lane = [
        entry({ kind: "future", title: "Lane entry", body: "Lane body." })
      ];
      const result = merge(root, lane);
      expect(result.merged).toHaveLength(2);
      expect(result.merged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "current", title: "Root entry" }),
          expect.objectContaining({ kind: "future", title: "Lane entry" })
        ])
      );
      expect(result.conflicts).toEqual([]);
    });

    it("deduplicates entries with the same key and body — preferring the lane version", () => {
      const root = [
        entry({ kind: "current", title: "Shared", body: "Same body.", source: "root-source" })
      ];
      const lane = [
        entry({ kind: "current", title: "Shared", body: "Same body.", source: "lane-source" })
      ];
      const result = merge(root, lane);
      expect(result.merged).toHaveLength(1);
      expect(result.merged[0]).toEqual(
        expect.objectContaining({ kind: "current", title: "Shared", body: "Same body.", source: "lane-source" })
      );
      expect(result.conflicts).toEqual([]);
    });

    it("reports a conflict when the same key has different bodies in root and lane", () => {
      const root = [
        entry({ kind: "current", title: "Disputed", body: "Root says X.", source: "root" })
      ];
      const lane = [
        entry({ kind: "current", title: "Disputed", body: "Lane says Y.", source: "lane" })
      ];
      const result = merge(root, lane);
      expect(result.conflicts).toHaveLength(1);

      const conflict = result.conflicts[0]!;
      expect(conflict.key).toBe("current::Disputed");
      expect(conflict.root).toEqual(expect.objectContaining({ body: "Root says X." }));
      expect(conflict.lane).toEqual(expect.objectContaining({ body: "Lane says Y." }));
    });

    it("preserves lane entry in merged when a conflict is reported", () => {
      const root = [entry({ kind: "path", title: "Plan", body: "Root plan." })];
      const lane = [entry({ kind: "path", title: "Plan", body: "Lane plan." })];
      const result = merge(root, lane);
      // Lane value is preserved in merged even when there's a conflict
      expect(result.merged).toHaveLength(1);
      expect(result.merged[0]).toEqual(
        expect.objectContaining({ kind: "path", title: "Plan", body: "Lane plan." })
      );
      expect(result.conflicts).toHaveLength(1);
    });

    it("handles multiple entries with mixed overlap and conflicts", () => {
      const root = [
        entry({ kind: "current", title: "Root-only", body: "R1." }),
        entry({ kind: "current", title: "Shared-ok", body: "Same." }),
        entry({ kind: "future", title: "Disputed", body: "Root future." })
      ];
      const lane = [
        entry({ kind: "current", title: "Lane-only", body: "L1." }),
        entry({ kind: "current", title: "Shared-ok", body: "Same." }),
        entry({ kind: "future", title: "Disputed", body: "Lane future." })
      ];
      const result = merge(root, lane);

      expect(result.merged).toHaveLength(4);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.key).toBe("future::Disputed");
    });

    it("treats kind differences as distinct keys — no false conflicts", () => {
      const root = [entry({ kind: "current", title: "Entry", body: "Root." })];
      const lane = [entry({ kind: "future", title: "Entry", body: "Lane." })];
      const result = merge(root, lane);

      expect(result.merged).toHaveLength(2);
      expect(result.conflicts).toEqual([]);
    });
  });
});
