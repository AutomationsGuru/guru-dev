import { describe, expect, it } from "vitest";

import { assemble } from '../../src/runtime/headlessPrintReceipt.js';

describe("assemble", () => {
  it("structures a successful non-interactive result", () => {
    expect(assemble({ text: "finished", toolsUsed: ["read", "bash"] })).toEqual({
      text: "finished",
      toolsUsed: ["read", "bash"],
      exitHint: "completed"
    });
  });

  it("turns an error field into an exit hint without dropping partial output", () => {
    expect(
      assemble({
        text: "partial result",
        toolsUsed: ["read"],
        error: "provider request failed"
      })
    ).toEqual({
      text: "partial result",
      toolsUsed: ["read"],
      exitHint: "error: provider request failed"
    });
  });
});
