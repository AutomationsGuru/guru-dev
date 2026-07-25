import { describe, expect, it, vi } from "vitest";

import { exportReport, type KernelTraceReport } from '../../src/session/kernelTraceExport.js';

describe("kernelTraceExport", () => {
  it("returns report with correct event count", () => {
    const events = [{ type: "turn-start" }, { type: "tool-call" }, { type: "turn-end" }];
    const redact = vi.fn((s: string) => s);
    const report = exportReport(events, redact);

    expect(report.eventCount).toBe(3);
    expect(report.redactedEvents).toHaveLength(3);
    expect(typeof report.generatedAt).toBe("string");
  });

  it("calls redact hook for string content in events", () => {
    const events = ["secret: api-key-123", { nested: "another-secret" }];
    const redact = vi.fn((s: string) => s.replace(/secret/g, "[REDACTED]"));
    const report: KernelTraceReport = exportReport(events, redact);

    expect(redact).toHaveBeenCalled();
    // basic redaction surface exercised
    expect(report.redactedEvents[0]).toContain("[REDACTED]");
  });
});
