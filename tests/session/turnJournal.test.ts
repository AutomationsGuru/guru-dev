import { describe, it, expect } from "vitest";
import { TurnJournal } from '../../src/session/turnJournal.js';

describe("TurnJournal", () => {
  it("appends and exports events", () => {
    const journal = new TurnJournal({
      maxCapacity: 10,
      sanitizer: (t) => t,
    });

    const res = journal.append({
      timestamp: "2026-07-19T09:00:00Z",
      kind: "decision",
      metadata: { reason: "test", confident: true, score: 99 },
    });

    expect(res).toEqual({ type: "ok" });

    const md = journal.exportMarkdown();
    expect(md).toContain("# Turn Journal");
    expect(md).toContain("## [2026-07-19T09:00:00Z] decision");
    expect(md).toContain("- **confident**: true");
    expect(md).toContain("- **reason**: test");
    expect(md).toContain("- **score**: 99");
  });

  it("scrubs every printable string through the sanitizer", () => {
    const sanitizer = (text: string) => text.replace(/SECRET/g, "[REDACTED]");
    const journal = new TurnJournal({ maxCapacity: 10, sanitizer });

    journal.append({
      timestamp: "2026-SECRET-TIME",
      kind: "tool_SECRET",
      metadata: {
        "key_SECRET": "value_SECRET",
        safeNum: 42,
        safeBool: false,
      }
    });

    const md = journal.exportMarkdown();
    expect(md).not.toContain("SECRET");
    expect(md).toContain("[REDACTED]");
    expect(md).toContain("## [2026-[REDACTED]-TIME] tool_[REDACTED]");
    expect(md).toContain("- **key_[REDACTED]**: value_[REDACTED]");
    expect(md).toContain("- **safeNum**: 42");
    expect(md).toContain("- **safeBool**: false");
  });

  it("enforces capacity and returns capacity_exceeded, preserving prior records", () => {
    const journal = new TurnJournal({ maxCapacity: 2, sanitizer: (t) => t });

    expect(journal.append({ timestamp: "1", kind: "A" })).toEqual({ type: "ok" });
    expect(journal.append({ timestamp: "2", kind: "B" })).toEqual({ type: "ok" });

    // 3rd append exceeds capacity
    expect(journal.append({ timestamp: "3", kind: "C" })).toEqual({ type: "capacity_exceeded" });

    const md = journal.exportMarkdown();
    // Prior records preserved
    expect(md).toContain("[1] A");
    expect(md).toContain("[2] B");
    // 3rd record omitted
    expect(md).not.toContain("[3] C");
  });

  it("preserves order of events", () => {
    const journal = new TurnJournal({ maxCapacity: 5, sanitizer: (t) => t });

    journal.append({ timestamp: "1", kind: "first" });
    journal.append({ timestamp: "2", kind: "second" });

    const md = journal.exportMarkdown();
    const idx1 = md.indexOf("first");
    const idx2 = md.indexOf("second");
    expect(idx1).toBeLessThan(idx2);
  });

  it("handles empty journal", () => {
    const journal = new TurnJournal({ maxCapacity: 5, sanitizer: (t) => t });
    expect(journal.exportMarkdown()).toBe("*No journal events recorded.*");
  });
});
