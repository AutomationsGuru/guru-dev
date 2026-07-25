import { describe, expect, it } from "vitest";

import {
  analyzeSpecGaps,
  type SpecGap,
  type SpecGapKind,
  type SpecGapSeverity
} from '../../src/planning/specAnalyzeGaps.js';

describe("analyzeSpecGaps", () => {
  it("returns an empty list for clean, acceptance-criteria-bearing text", () => {
    const text = [
      "REQ-1: The harness must persist memory as Markdown.",
      "AC: Memory file exists after write."
    ].join("\n");

    expect(analyzeSpecGaps(text)).toEqual<SpecGap[]>([]);
  });

  it("returns an empty list for empty or whitespace-only text", () => {
    expect(analyzeSpecGaps("")).toEqual<SpecGap[]>([]);
    expect(analyzeSpecGaps("   \n\t  \n")).toEqual<SpecGap[]>([]);
  });

  it("flags the TBD ambiguity keyword with line, column, and keyword", () => {
    const text = "REQ-2: TBD how the cache is invalidated.";

    const ambiguity = analyzeSpecGaps(text).filter(
      (g) => g.kind === "ambiguity-keyword"
    );

    expect(ambiguity).toHaveLength(1);
    const gap = ambiguity[0]!;
    expect(gap.keyword).toBe("TBD");
    expect(gap.line).toBe(1);
    expect(gap.column).toBe(8);
    expect(gap.snippet).toContain("TBD");
    expect(gap.severity).toBe<SpecGapSeverity>("warning");
  });

  it("flags all documented ambiguity keywords case-insensitively", () => {
    const text = "REQ-3: maybe we cache. somehow it syncs. tbd later.";

    const keywords = analyzeSpecGaps(text)
      .filter((g) => g.kind === "ambiguity-keyword")
      .map((g) => g.keyword as string);

    expect(keywords.sort()).toEqual(["maybe", "somehow", "tbd"]);
  });

  it("flags a missing acceptance-criteria marker on a requirement without AC", () => {
    const text = "REQ-4: The harness must retry failed model calls.";

    const gaps = analyzeSpecGaps(text);

    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.kind).toBe<SpecGapKind>("missing-acceptance-criteria");
    expect(gap.line).toBe(1);
    expect(gap.severity).toBe<SpecGapSeverity>("warning");
    expect(gap.message).toMatch(/acceptance/i);
  });

  it("recognizes AC markers of varying forms and does not flag missing AC", () => {
    const cases = [
      "REQ-5: Do work.\nAC: observable outcome.",
      "REQ-6: Do work.\nAcceptance Criteria: observable outcome.",
      "REQ-7: Do work.\nShould: observable outcome.",
      "REQ-8: Do work.\nGiven a request, When it runs, Then it returns ok."
    ];

    for (const text of cases) {
      const acGaps = analyzeSpecGaps(text).filter(
        (g) => g.kind === "missing-acceptance-criteria"
      );
      expect(acGaps, `expected no missing-AC gap for:\n${text}`).toEqual<SpecGap[]>([]);
    }
  });

  it("reports stable 1-based line and column positions across multiple lines", () => {
    // The whole document carries an AC marker, so missing-AC does not fire;
    // only the ambiguity keyword on line 2 is reported.
    const text = [
      "REQ-9: Clean line.",
      "REQ-10: maybe flaky line.",
      "AC: observable outcome."
    ].join("\n");

    const gaps = analyzeSpecGaps(text);

    expect(gaps).toHaveLength(1);
    const maybe = gaps.find((g) => g.keyword === "maybe");
    expect(maybe?.line).toBe(2);
    expect(maybe?.column).toBe(9);
  });

  it("de-duplicates ambiguity hits on the same line for the same keyword", () => {
    const text = "REQ-11: maybe x. maybe y.";

    const maybes = analyzeSpecGaps(text).filter((g) => g.keyword === "maybe");

    expect(maybes).toHaveLength(1);
    expect(maybes[0]!.line).toBe(1);
  });

  it("sorts gaps by line then column with a stable order", () => {
    const text = [
      "REQ-12: maybe a.", // line 1: maybe @ col 9
      "REQ-13: no keyword but missing AC." // line 2: missing-AC
    ].join("\n");

    const gaps = analyzeSpecGaps(text);

    expect(gaps.map((g) => `${g.line}:${g.kind}`)).toEqual([
      "1:missing-acceptance-criteria", // column 1 sorts before column 9
      "1:ambiguity-keyword",
      "2:missing-acceptance-criteria"
    ]);
  });

  it("does not treat ambiguity keywords inside other words as matches", () => {
    const text = "REQ-14: The alumnaybe field and the ambitbd path.";

    expect(analyzeSpecGaps(text).filter((g) => g.kind === "ambiguity-keyword")).toEqual<
      SpecGap[]
    >([]);
  });
});
