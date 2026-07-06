import { describe, expect, it } from "vitest";

import { parseGateFailure } from "../../src/selfbuild/parseGateFailure.js";

describe("parseGateFailure (P3) — RED gate output → structured failure note", () => {
  it("tsc output → tsc kind + the error lines", () => {
    const note = parseGateFailure({
      name: "typecheck",
      command: ["npm", "run", "typecheck"],
      stdout: "src/x.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/y.ts(9,1): error TS2339: Property 'z' does not exist.",
      stderr: "",
      exitCode: 2
    });
    expect(note.kind).toBe("tsc");
    expect(note.failures).toHaveLength(2);
    expect(note.failures[0]).toMatch(/TS2322/u);
    expect(note.summary).toMatch(/2 issue/u);
  });

  it("vitest output → vitest kind + FAIL lines", () => {
    const note = parseGateFailure({
      name: "test",
      command: ["npm", "run", "test"],
      stdout: "FAIL tests/a.test.ts > does a thing\n × expected 1 to be 2",
      stderr: "",
      exitCode: 1
    });
    expect(note.kind).toBe("vitest");
    expect(note.failures.some((f) => /FAIL/u.test(f))).toBe(true);
  });

  it("unknown command → generic tail (never empty on real output)", () => {
    const note = parseGateFailure({ name: "lint", command: ["make", "lint"], stdout: "", stderr: "some failure\nanother line", exitCode: 1 });
    expect(note.kind).toBe("generic");
    expect(note.failures.length).toBeGreaterThan(0);
  });

  it("a non-vitest runner (cargo test) matched as vitest still extracts failures (not silently dropped)", () => {
    const note = parseGateFailure({
      name: "test",
      command: ["cargo", "test"],
      stdout: "test tests::adds ... FAILED\ntest result: FAILED. 2 passed; 1 failed;",
      stderr: "",
      exitCode: 101
    });
    expect(note.failures.length).toBeGreaterThan(0); // generic fallback caught the failure lines
  });

  it("caps failures at 10 and de-dups", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts(1,1): error TS1000: boom`).join("\n");
    const note = parseGateFailure({ name: "typecheck", command: ["tsc"], stdout: lines, stderr: "", exitCode: 2 });
    expect(note.failures.length).toBeLessThanOrEqual(10);
    expect(note.raw.length).toBeLessThanOrEqual(2_000);
  });
});
