import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { expandReferences } from "../../src/tui/references.js";
import { clearRegisteredSecretValues, registerSecretValue } from "../../src/safety/secretSafety.js";

const root = join(tmpdir(), `guru-refs-${process.pid}`);
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "small.ts"), "export const x = 1;\n");
writeFileSync(join(root, "src", "big.ts"), "A".repeat(200 * 1024));
writeFileSync(join(root, "secret.txt"), "token = sk-abcdefghijklmnop1234\n");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  clearRegisteredSecretValues();
});

const opts = (over: object = {}) => ({ repoRoot: root, baseTokens: 0, contextWindowTokens: 128_000, ...over });

describe("expandReferences", () => {
  it("no @ tokens → text unchanged, no notices", () => {
    const result = expandReferences("just a normal prompt", opts());
    expect(result.text).toBe("just a normal prompt");
    expect(result.notices).toEqual([]);
  });

  it("ACCEPTANCE: @src/small.ts inlines the file contents in a fenced block", () => {
    const result = expandReferences("explain @src/small.ts please", opts());
    expect(result.text).toContain("explain");
    expect(result.text).toContain("export const x = 1;");
    expect(result.text).toContain("src/small.ts");
    expect(result.text).toContain("please");
  });

  it("multi-file additive", () => {
    writeFileSync(join(root, "src", "two.ts"), "export const y = 2;\n");
    const result = expandReferences("@src/small.ts and @src/two.ts", opts());
    expect(result.text).toContain("export const x = 1;");
    expect(result.text).toContain("export const y = 2;");
  });

  it("50KB guard: an oversized file is head/tail truncated with a notice", () => {
    const result = expandReferences("@src/big.ts", opts());
    expect(result.text).toContain("bytes truncated");
    expect(result.notices.some((notice) => notice.includes("truncated"))).toBe(true);
    expect(result.text.length).toBeLessThan(200 * 1024);
  });

  it("80%-window guard: a reference that would blow the budget is SKIPPED, not sent", () => {
    // Tiny window so even small.ts exceeds 80%.
    const result = expandReferences("@src/small.ts", opts({ contextWindowTokens: 4, baseTokens: 0 }));
    expect(result.text).toBe("@src/small.ts"); // left literal
    expect(result.notices.some((notice) => notice.includes("80%"))).toBe(true);
  });

  it("secret scrub: a referenced secret never lands in the prompt", () => {
    registerSecretValue("sk-abcdefghijklmnop1234");
    const result = expandReferences("@secret.txt", opts());
    expect(result.text).not.toContain("sk-abcdefghijklmnop1234");
    expect(result.text).toContain("redacted");
  });

  it("containment + missing: escapes and non-existent paths are skipped with notices", () => {
    const escape = expandReferences("@../../etc/passwd", opts());
    expect(escape.notices[0]).toContain("outside");
    const missing = expandReferences("@src/nope.ts", opts());
    expect(missing.notices[0]).toContain("not found");
  });

  it("symlink containment: an in-repo link pointing OUTSIDE the root is not inlined", () => {
    const outside = join(tmpdir(), `guru-refs-outside-${process.pid}.txt`);
    writeFileSync(outside, "SECRET-OUTSIDE-CONTENT\n");
    let linked = false;
    try {
      symlinkSync(outside, join(root, "escape.txt"));
      linked = true;
    } catch {
      // Symlink creation may be unprivileged-denied (e.g. Windows) — skip then.
    }
    if (!linked) {
      rmSync(outside, { force: true });
      return;
    }
    const result = expandReferences("@escape.txt", opts());
    expect(result.text).not.toContain("SECRET-OUTSIDE-CONTENT");
    expect(result.notices.some((notice) => notice.includes("outside"))).toBe(true);
    rmSync(outside, { force: true });
  });
});
