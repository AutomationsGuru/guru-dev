import { describe, expect, it } from "vitest";

import {
  buildStartupContext,
  DEFAULT_MAX_LISTING_ENTRIES
} from '../../src/context/syntheticStartupContext.js';

const FIXED_DATE = new Date(Date.UTC(2026, 6, 19, 12, 0, 0));

describe("buildStartupContext", () => {
  it("includes the cwd, OS, and date", () => {
    const text = buildStartupContext({
      cwd: "/home/operator/project",
      os: "linux",
      date: FIXED_DATE,
      listing: ["package.json", "src", "tests"]
    });
    expect(text).toContain("Working directory: /home/operator/project");
    expect(text).toContain("OS: linux");
    expect(text).toContain("Date: 2026-07-19");
    expect(text).toContain("  - package.json");
    expect(text).toContain("  - src");
    expect(text).toContain("  - tests");
  });

  it("injects the date deterministically from the injected clock, not the wall clock", () => {
    const a = buildStartupContext({ cwd: "/x", os: "linux", date: FIXED_DATE, listing: [] });
    const b = buildStartupContext({ cwd: "/x", os: "linux", date: FIXED_DATE, listing: [] });
    expect(a).toBe(b);
    const other = buildStartupContext({
      cwd: "/x",
      os: "linux",
      date: new Date(Date.UTC(2030, 0, 2)),
      listing: []
    });
    expect(other).toContain("Date: 2030-01-02");
    expect(other).not.toBe(a);
  });

  it("caps a long listing at the default and reports the omission count", () => {
    const listing = Array.from({ length: DEFAULT_MAX_LISTING_ENTRIES + 25 }, (_, i) => `entry-${i}`);
    const text = buildStartupContext({ cwd: "/big", os: "linux", date: FIXED_DATE, listing });
    expect(text).toContain("  - entry-0");
    expect(text).toContain(`  - entry-${DEFAULT_MAX_LISTING_ENTRIES - 1}`);
    expect(text).not.toContain(`  - entry-${DEFAULT_MAX_LISTING_ENTRIES}`);
    expect(text).toContain(`(${DEFAULT_MAX_LISTING_ENTRIES} of ${listing.length} entries shown)`);
    expect(text).toContain("… 25 more entries omitted (shallow listing cap)");
  });

  it("honors an explicit maxListingEntries override", () => {
    const text = buildStartupContext({
      cwd: "/big",
      os: "linux",
      date: FIXED_DATE,
      listing: ["a", "b", "c", "d", "e"],
      maxListingEntries: 2
    });
    expect(text).toContain("  - a");
    expect(text).toContain("  - b");
    expect(text).not.toContain("  - c");
    expect(text).toContain("… 3 more entries omitted (shallow listing cap)");
  });

  it("renders an empty listing without an omission note", () => {
    const text = buildStartupContext({ cwd: "/empty", os: "linux", date: FIXED_DATE, listing: [] });
    expect(text).toContain("(0 of 0 entries shown)");
    expect(text).not.toContain("omitted");
  });
});
