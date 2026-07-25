import { describe, expect, it } from "vitest";

import {
  buildIndex,
  queryByTag,
  type SkillTagEntry
} from '../../src/garage/garageSkillTagIndex.js';

const SAMPLE: readonly SkillTagEntry[] = [
  { id: "zeta-skill", tags: ["typescript", "garage"] },
  { id: "alpha-skill", tags: ["typescript", "inject"] },
  { id: "mid-skill", tags: ["garage", "inject"] },
  { id: "solo-skill", tags: ["solo"] }
];

describe("garageSkillTagIndex", () => {
  describe("buildIndex + queryByTag multi-tag", () => {
    it("indexes a skill under every of its tags", () => {
      const index = buildIndex(SAMPLE);

      expect(queryByTag(index, "typescript")).toEqual(["alpha-skill", "zeta-skill"]);
      expect(queryByTag(index, "garage")).toEqual(["mid-skill", "zeta-skill"]);
      expect(queryByTag(index, "inject")).toEqual(["alpha-skill", "mid-skill"]);
      expect(queryByTag(index, "solo")).toEqual(["solo-skill"]);
    });

    it("returns stable lexicographically sorted ids regardless of input order", () => {
      const reversed: readonly SkillTagEntry[] = [...SAMPLE].reverse();
      const a = queryByTag(buildIndex(SAMPLE), "typescript");
      const b = queryByTag(buildIndex(reversed), "typescript");

      expect(a).toEqual(["alpha-skill", "zeta-skill"]);
      expect(b).toEqual(a);
      expect([...a]).toEqual([...a].sort());
    });

    it("dedupes the same skill id listed twice under one tag", () => {
      const index = buildIndex([
        { id: "dup", tags: ["t", "t"] },
        { id: "dup", tags: ["t"] },
        { id: "other", tags: ["t"] }
      ]);

      expect(queryByTag(index, "t")).toEqual(["dup", "other"]);
    });
  });

  describe("empty-tag and miss behavior", () => {
    it("returns an empty list for empty / whitespace-only query tags", () => {
      const index = buildIndex(SAMPLE);

      expect(queryByTag(index, "")).toEqual([]);
      expect(queryByTag(index, "   ")).toEqual([]);
      expect(queryByTag(index, "\t\n")).toEqual([]);
    });

    it("returns an empty list for unknown tags", () => {
      const index = buildIndex(SAMPLE);
      expect(queryByTag(index, "missing-tag")).toEqual([]);
    });

    it("never materializes empty tags as index keys", () => {
      const index = buildIndex([
        { id: "kept", tags: ["real", "", "  ", "\t"] },
        { id: "  ", tags: ["ghost"] },
        { id: "", tags: ["ghost"] }
      ]);

      expect(queryByTag(index, "real")).toEqual(["kept"]);
      expect(queryByTag(index, "")).toEqual([]);
      expect(queryByTag(index, "ghost")).toEqual([]);
      expect([...index.keys()]).toEqual(["real"]);
    });

    it("builds an empty index from an empty skill list", () => {
      const index = buildIndex([]);
      expect(index.size).toBe(0);
      expect(queryByTag(index, "anything")).toEqual([]);
      expect(queryByTag(index, "")).toEqual([]);
    });
  });

  describe("normalization", () => {
    it("trims skill ids and tags when building and querying", () => {
      const index = buildIndex([{ id: "  padded-id  ", tags: ["  pad-tag  "] }]);
      expect(queryByTag(index, "pad-tag")).toEqual(["padded-id"]);
      expect(queryByTag(index, "  pad-tag  ")).toEqual(["padded-id"]);
    });
  });
});
