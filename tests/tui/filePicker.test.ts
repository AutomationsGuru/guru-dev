import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildReferencePickerEntries, completePathToken, filterFiles, fuzzyScore, scanRepoFiles } from "../../src/tui/filePicker.js";

const root = join(tmpdir(), `guru-picker-${process.pid}`);
mkdirSync(join(root, "src", "compaction"), { recursive: true });
mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
mkdirSync(join(root, ".git"), { recursive: true });
writeFileSync(join(root, "src", "compaction", "cutPoint.ts"), "x");
writeFileSync(join(root, "src", "compaction", "engine.ts"), "x");
writeFileSync(join(root, "src", "guru.ts"), "x");
writeFileSync(join(root, "node_modules", "junk", "index.js"), "x");
writeFileSync(join(root, ".git", "HEAD"), "x");
writeFileSync(join(root, "README.md"), "x");
writeFileSync(join(root, ".env"), "SECRET=1");
writeFileSync(join(root, ".env.local"), "SECRET=1");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanRepoFiles — bounded walk", () => {
  it("finds repo files, skips .git/node_modules, reports POSIX-relative paths", () => {
    const scan = scanRepoFiles(root);
    expect(scan.files).toContain("src/compaction/cutPoint.ts");
    expect(scan.files).toContain("README.md");
    expect(scan.files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(scan.files.some((file) => file.includes(".git"))).toBe(false);
    expect(scan.truncated).toBe(false);
  });

  it("caps the walk and says so", () => {
    const scan = scanRepoFiles(root, { cap: 2 });
    expect(scan.files.length).toBeLessThanOrEqual(2);
    expect(scan.truncated).toBe(true);
  });

  it(".env* files never enter the picker (secret guardrail)", () => {
    const scan = scanRepoFiles(root);
    expect(scan.files).not.toContain(".env");
    expect(scan.files).not.toContain(".env.local");
  });

  it("bounds directory-heavy trees too — the walk itself is capped (review follow-up)", () => {
    const dirRoot = join(tmpdir(), `guru-picker-dirs-${process.pid}`);
    for (let index = 0; index < 30; index += 1) {
      mkdirSync(join(dirRoot, `dir-${index}`), { recursive: true });
    }
    try {
      const scan = scanRepoFiles(dirRoot, { cap: 1 }); // entry cap = 25 < 30 dirs
      expect(scan.truncated).toBe(true);
    } finally {
      rmSync(dirRoot, { recursive: true, force: true });
    }
  });
});

describe("fuzzy matching", () => {
  it("ACCEPTANCE: 'cutP' surfaces cutPoint.ts first", () => {
    const scan = scanRepoFiles(root);
    const matches = filterFiles(scan.files, "cutP");
    expect(matches[0]?.path).toBe("src/compaction/cutPoint.ts");
  });

  it("subsequence in order matches; out-of-order does not", () => {
    expect(fuzzyScore("gru", "src/guru.ts")).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore("urg", "src/guru.ts")).toBe(-1); // no 'g' after the 'r' that follows 'u'
    expect(fuzzyScore("zzz", "src/guru.ts")).toBe(-1);
  });

  it("contiguous + basename hits outrank scattered matches", () => {
    const contiguous = fuzzyScore("engine", "src/compaction/engine.ts");
    const scattered = fuzzyScore("engine", "src/e/n/g/i/n/e-x.md");
    expect(contiguous).toBeGreaterThan(scattered);
  });
});

describe("virtual reference picker", () => {
  const dynamic = [
    { value: "@session:session-123", label: "@session:session-123", hint: "Saved session" },
    { value: "@memory:oauth-login", label: "@memory:oauth-login", hint: "OAuth login" }
  ];

  it("always offers all four static roots and preserves the leading @", () => {
    const entries = buildReferencePickerEntries(["src/guru.ts"], dynamic, "", 20);
    expect(entries.map(({ value }) => value)).toEqual(expect.arrayContaining([
      "@session:",
      "@memory:",
      "@git-changes",
      "@terminal",
      "@session:session-123",
      "@memory:oauth-login",
      "src/guru.ts"
    ]));
  });

  it("filters static and dynamic suggestions deterministically without changing file values", () => {
    const first = buildReferencePickerEntries(["src/guru.ts"], dynamic, "session123", 8);
    const second = buildReferencePickerEntries(["src/guru.ts"], [...dynamic].reverse(), "session123", 8);
    expect(first).toEqual(second);
    expect(first[0]?.value).toBe("@session:session-123");

    const file = buildReferencePickerEntries(["src/guru.ts"], dynamic, "guru", 8);
    expect(file.some(({ value }) => value === "src/guru.ts")).toBe(true);
    expect(file.some(({ value }) => value === "@src/guru.ts")).toBe(false);
  });
});

describe("completePathToken — Tab paths", () => {
  it("ACCEPTANCE: 'src/comp' completes to 'src/compaction/'", () => {
    const completion = completePathToken("src/comp", root);
    expect(completion.completed).toBe("src/compaction/");
  });

  it("ambiguous stems extend to the longest common prefix with candidates listed", () => {
    const completion = completePathToken("src/compaction/", root);
    // both cutPoint.ts and engine.ts live there → no common stem beyond ""
    expect(completion.candidates.length).toBe(2);
  });

  it("unknown paths return the token unchanged", () => {
    const completion = completePathToken("nope/missing", root);
    expect(completion.completed).toBe("nope/missing");
    expect(completion.candidates).toEqual([]);
  });

  it(".env* never completes, even with the leading dot typed (secret guardrail)", () => {
    const completion = completePathToken(".env", root);
    expect(completion.completed).toBe(".env"); // unchanged — no .env/.env.local surfaced
    expect(completion.candidates).toEqual([]);
  });
});
