import { describe, expect, it } from "vitest";

import {
  BashOptimizerConfigSchema,
  dedupLines,
  filterNoise,
  groupRepeats,
  middleTruncate,
  optimizeBashOutput
} from "../../src/tools/bashOptimizer.js";

const enabled = (overrides: object = {}) => BashOptimizerConfigSchema.parse({ enabled: true, minBytes: 8, ...overrides });

describe("the four strategies", () => {
  it("Strategy 1 — strips ANSI, CR-progress, spinner frames, pkg chatter", () => {
    const noisy = "\x1b[32mok\x1b[0m\nprogress 10%\rprogress 100%\n⠋\nnpm warn deprecated thing\nreal line";
    const clean = filterNoise(noisy);
    expect(clean).not.toContain("\x1b[");
    expect(clean).not.toContain("progress 10%"); // CR-overwritten line split
    expect(clean).not.toContain("npm warn");
    expect(clean).toContain("real line");
  });

  it("Strategy 2 — groups repeated error codes with counts", () => {
    const errors = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts(1,1): error TS2345: bad arg`).join("\n");
    const grouped = groupRepeats(errors);
    expect(grouped).toContain("TS2345 (7 occurrences)");
    expect(grouped.split("\n").filter((line) => line.includes("TS2345")).length).toBe(1);
  });

  it("Strategy 3 — MIDDLE truncation keeps head + tail and spills the full output", () => {
    const output = `HEAD${"x".repeat(200)}TAIL`;
    let spilled: string | null = null;
    const result = middleTruncate(output, 10, 10, (full) => {
      spilled = full;
      return "/tmp/spill.log";
    });
    expect(result.startsWith("HEAD")).toBe(true);
    expect(result.endsWith("TAIL")).toBe(true);
    expect(result).toContain("full output at /tmp/spill.log");
    expect(spilled).toBe(output);
  });

  it("Strategy 4 — dedups repeated lines with ×N and timestamp normalization", () => {
    const logs = [
      "2026-07-05T01:00:00Z Connection refused",
      "2026-07-05T01:00:01Z Connection refused",
      "2026-07-05T01:00:02Z Connection refused",
      "done"
    ].join("\n");
    const deduped = dedupLines(logs);
    expect(deduped).toContain("[…×3]");
    expect(deduped).toContain("done");
  });
});

describe("optimizeBashOutput — pipeline + guards", () => {
  it("is OFF by default (config default) and honest when off", () => {
    const config = BashOptimizerConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    const result = optimizeBashOutput("x".repeat(5_000), ["npm", "test"], config);
    expect(result.optimized).toBe(false);
    expect(result.output).toBe("x".repeat(5_000));
  });

  it("when enabled: compresses noisy test output and annotates visibly", () => {
    const noisy = Array.from({ length: 200 }, () => "\x1b[32m✓\x1b[0m test passed 2026-07-05T00:00:00Z ok").join("\n");
    const result = optimizeBashOutput(noisy, ["npm", "test"], enabled());
    expect(result.optimized).toBe(true);
    expect(result.output.length).toBeLessThan(noisy.length);
    expect(result.note).toMatch(/\[guru: bash output optimized \d+→\d+ chars\]/u);
  });

  it("NEVER-WORSE guard: output that would compress to nothing returns the ORIGINAL", () => {
    const allNoise = "\x1b[32m\x1b[0m\n⠋\n⠙\n";
    const result = optimizeBashOutput(allNoise.repeat(10), ["npm", "test"], enabled());
    expect(result.optimized).toBe(false);
    expect(result.output).toBe(allNoise.repeat(10));
  });

  it("small outputs are left alone (minBytes)", () => {
    const result = optimizeBashOutput("tiny", ["ls"], enabled({ minBytes: 2_048 }));
    expect(result.optimized).toBe(false);
  });
});
