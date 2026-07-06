import { describe, expect, it } from "vitest";
import { commandExists } from "../../src/review/gates.js";

describe("commandExists (P0) — attach-if-present probe", () => {
  it("finds a real command and misses a fake one (presence only)", () => {
    expect(commandExists("node")).toBe(true);
    expect(commandExists("definitely-not-a-real-cmd-xyz-42")).toBe(false);
  });
});
