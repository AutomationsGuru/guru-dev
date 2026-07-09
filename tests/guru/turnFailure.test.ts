import { describe, expect, it } from "vitest";

import { formatTurnFailureLines } from "../../src/guru.js";

describe("formatTurnFailureLines", () => {
  it("returns an abort message without a failure tip", () => {
    const lines = formatTurnFailureLines("The operation was aborted", true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/turn stopped/i);
    expect(lines.join("\n")).not.toMatch(/Turn failed:/);
  });

  it("returns a failure line and a retry tip for real errors", () => {
    const lines = formatTurnFailureLines("HTTP 503 from provider", false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Turn failed: HTTP 503/);
    expect(lines[1]).toMatch(/tip:/i);
  });
});