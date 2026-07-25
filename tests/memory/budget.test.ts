import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateMemoryBudget, wouldExceedBudget } from "../../src/memory/budget.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guru-memory-budget-"));
  tempDirectories.push(directory);
  return directory;
}

function writeFact(directory: string, name: string, bytes: number): void {
  writeFileSync(join(directory, `${name}.md`), "x".repeat(bytes));
}

describe("evaluateMemoryBudget", () => {
  it("reports ok with full headroom on an empty directory", () => {
    const directory = makeTempDirectory();
    const report = evaluateMemoryBudget(directory, { maxBytes: 1000 });

    expect(report.status).toBe("ok");
    expect(report.usedBytes).toBe(0);
    expect(report.headroomBytes).toBe(1000);
    expect(report.factFiles).toBe(0);
  });

  it("counts durable fact bytes but excludes the derived MEMORY.md index", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "fact-a", 100);
    writeFact(directory, "fact-b", 200);
    writeFileSync(join(directory, "MEMORY.md"), "x".repeat(500)); // derived, not counted

    const report = evaluateMemoryBudget(directory, { maxBytes: 1000 });

    expect(report.usedBytes).toBe(300);
    expect(report.factFiles).toBe(2);
  });

  it("counts .trash bytes separately so GC frees real headroom", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "live", 100);
    mkdirSync(join(directory, ".trash"), { recursive: true });
    writeFileSync(join(directory, ".trash", "old.1.md"), "x".repeat(400));

    const report = evaluateMemoryBudget(directory, { maxBytes: 1000 });

    expect(report.usedBytes).toBe(100);
    expect(report.trashBytes).toBe(400);
  });

  it("warns at the fraction threshold", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "fact", 850); // 85% of 1000, warn at 0.8

    const report = evaluateMemoryBudget(directory, { maxBytes: 1000, warnAtFraction: 0.8 });

    expect(report.status).toBe("warn");
    expect(report.headroomBytes).toBe(150);
  });

  it("reports exceeded over the hard ceiling", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "fact", 1200);

    const report = evaluateMemoryBudget(directory, { maxBytes: 1000 });

    expect(report.status).toBe("exceeded");
    expect(report.headroomBytes).toBe(0);
    expect(report.summary).toContain("EXCEEDED");
  });
});

describe("wouldExceedBudget", () => {
  it("allows a write that fits within the ceiling", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "fact", 300);

    const { allowed, report } = wouldExceedBudget(directory, 500, { maxBytes: 1000 });

    expect(allowed).toBe(true);
    expect(report.usedBytes).toBe(300);
  });

  it("refuses a write that would cross the ceiling", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "fact", 800);

    const { allowed } = wouldExceedBudget(directory, 300, { maxBytes: 1000 });

    expect(allowed).toBe(false);
  });

  it("allows a write that lands exactly on the ceiling", () => {
    const directory = makeTempDirectory();
    writeFact(directory, "fact", 700);

    const { allowed } = wouldExceedBudget(directory, 300, { maxBytes: 1000 });

    expect(allowed).toBe(true);
  });
});
