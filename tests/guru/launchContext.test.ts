import { describe, expect, it } from "vitest";

import { detectSuitIntent, formatTodayLine } from "../../src/guru/launchContext.js";

describe("formatTodayLine — the date the model gets (§17 scenario 14)", () => {
  it("formats the operator's LOCAL calendar date with a matching ISO date (not UTC)", () => {
    const line = formatTodayLine(new Date(2026, 6, 5, 20, 30)); // 5 July, local evening
    expect(line).toContain("5 July 2026");
    expect(line).toContain("(2026-07-05)");
    expect(line.startsWith("Today is ")).toBe(true);
  });

  it("names the weekday", () => {
    // 2026-01-01 is a Thursday (local construction).
    expect(formatTodayLine(new Date(2026, 0, 1))).toContain("Thursday");
  });
});

describe("detectSuitIntent — plain prose → a suit topic (§17 scenario 14)", () => {
  it("derives the topic from work-declaration phrasings", () => {
    expect(detectSuitIntent("finances today")).toBe("finances");
    expect(detectSuitIntent("let's do the ledger reconciliation")).toBe("the ledger reconciliation");
    expect(detectSuitIntent("working on the auth refactor")).toBe("the auth refactor");
    expect(detectSuitIntent("we're doing invoice cleanup")).toBe("invoice cleanup");
    expect(detectSuitIntent("today: finances")).toBe("finances");
    expect(detectSuitIntent("time for the migration")).toBe("the migration");
  });

  it("returns null for questions, commands, @-refs, and bang lines (NOT declarations)", () => {
    expect(detectSuitIntent("what should we work on?")).toBeNull();
    expect(detectSuitIntent("/role list")).toBeNull();
    expect(detectSuitIntent("@src/guru.ts explain this")).toBeNull();
    expect(detectSuitIntent("!ls")).toBeNull();
  });

  it("returns null for a real prompt (too long to be a 'what today is' declaration)", () => {
    expect(detectSuitIntent("please fix the failing test in the parser module and rerun the suite")).toBeNull();
  });

  it("returns null for chit-chat that merely ends in 'today' (leading filler guard)", () => {
    expect(detectSuitIntent("it's hot today")).toBeNull();
    expect(detectSuitIntent("that was rough today")).toBeNull();
    expect(detectSuitIntent("nothing today")).toBeNull();
  });

  it("does not fire when there is no declaration", () => {
    expect(detectSuitIntent("hello")).toBeNull();
    expect(detectSuitIntent("explain the router")).toBeNull();
  });
});
