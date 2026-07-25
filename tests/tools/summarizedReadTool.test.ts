import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSummarizedReadTool,
  extractStructure,
  summarizeText
} from '../../src/tools/summarizedReadTool.js';

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

describe("summarizeText (pure)", () => {
  it("returns the full text when it fits within maxBytes", () => {
    const text = "hello\nworld\n";
    const result = summarizeText(text, 1000);
    expect(result.summarized).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.head).toBe(text);
    expect(result.structure).toEqual([]);
    expect(result.totalBytes).toBe(byteLength(text));
  });

  it("summarizes text over maxBytes with a bounded head and structure", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} of filler text`).join("\n");
    const text = `# Title\n\nexport function alpha() {\n  return 1;\n}\n\n${body}\n`;
    const maxBytes = 200;
    const result = summarizeText(text, maxBytes);
    expect(result.summarized).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(byteLength(text));
    expect(byteLength(result.head)).toBeLessThanOrEqual(maxBytes);
    expect(result.head.startsWith("# Title")).toBe(true);
    expect(result.structure).toContain("# Title");
    expect(result.structure.some((entry) => entry.startsWith("L3: export function alpha("))).toBe(true);
  });

  it("cuts on a line boundary when a newline exists within maxBytes", () => {
    const text = `${"a".repeat(50)}\n${"b".repeat(50)}\n${"c".repeat(500)}`;
    const result = summarizeText(text, 80);
    expect(result.head).toBe(`${"a".repeat(50)}\n`);
  });

  it("cuts a single over-long line without splitting a UTF-8 code point", () => {
    const text = "é".repeat(500); // 2 bytes per char, no newline
    const maxBytes = 101; // odd byte count lands mid-character
    const result = summarizeText(text, maxBytes);
    expect(result.summarized).toBe(true);
    expect(byteLength(result.head)).toBeLessThanOrEqual(maxBytes);
    expect(result.head).not.toContain("�");
  });

  it("never emits U+FFFD when the cut lands inside multi-byte characters", () => {
    const prefix = "日本語のテキスト。".repeat(20); // multi-byte run near the cut
    const text = `${prefix}\n${"x".repeat(5000)}`;
    for (const maxBytes of [1, 2, 3, 5, 7, 11, 13, 17]) {
      const result = summarizeText(text, maxBytes);
      expect(result.head).not.toContain("�");
      expect(byteLength(result.head)).toBeLessThanOrEqual(maxBytes);
    }
  });

  it("treats exactly-maxBytes text as small (no summarization)", () => {
    const text = "abcd";
    const result = summarizeText(text, 4);
    expect(result.summarized).toBe(false);
    expect(result.head).toBe(text);
  });
});

describe("extractStructure (pure)", () => {
  it("picks markdown headings verbatim and declarations with line numbers", () => {
    const text = [
      "# Overview",
      "",
      "Some prose.",
      "export function buildIndex() {",
      "  return null;",
      "}",
      "## Details",
      "class Widget {",
      "}",
      "  const indented = 1;",
      "const plain = 2;",
      "not a declaration"
    ].join("\n");
    const structure = extractStructure(text);
    expect(structure).toContain("# Overview");
    expect(structure).toContain("## Details");
    expect(structure).toContain("L4: export function buildIndex() {");
    expect(structure).toContain("L8: class Widget {");
    expect(structure).toContain("L10:   const indented = 1;");
    expect(structure).toContain("L11: const plain = 2;");
    expect(structure.some((entry) => entry.includes("not a declaration"))).toBe(false);
  });

  it("elides structure beyond 100 entries with a final count note", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `export function fn${i}() {}`);
    const structure = extractStructure(lines.join("\n"));
    expect(structure).toHaveLength(101);
    expect(structure[100]).toBe("… (50 more)");
  });
});

describe("summarized_read tool", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "summarized-read-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns full contents for a small file", async () => {
    const text = "small file\nwith two lines\n";
    await writeFile(join(repoRoot, "small.txt"), text, "utf8");
    const tool = createSummarizedReadTool();
    const out = await tool.execute({ repoRoot, path: "small.txt", maxBytes: 20000 }, {});
    expect(out.exists).toBe(true);
    expect(out.isBinary).toBe(false);
    expect(out.summarized).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out.contents).toBe(text);
    expect(out.head).toBeUndefined();
    expect(out.blockers).toEqual([]);
    expect(out.totalBytes).toBe(byteLength(text));
    expect(out.summary).toBe(`Returned full text (${byteLength(text)} bytes).`);
  });

  it("summarizes a large file into head plus structure", async () => {
    const filler = Array.from({ length: 500 }, (_, i) => `filler line ${i}`).join("\n");
    const text = `# Big Doc\n\nexport class BigThing {}\n\n${filler}\n`;
    await writeFile(join(repoRoot, "big.md"), text, "utf8");
    const tool = createSummarizedReadTool();
    const out = await tool.execute({ repoRoot, path: "big.md", maxBytes: 300 }, {});
    expect(out.exists).toBe(true);
    expect(out.summarized).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.contents).toBeUndefined();
    expect(out.head).toBeDefined();
    expect(byteLength(out.head ?? "")).toBeLessThanOrEqual(300);
    expect(out.head).not.toContain("�");
    expect(out.structure).toContain("# Big Doc");
    expect(out.structure?.some((entry) => entry === "L3: export class BigThing {}")).toBe(true);
    expect(out.maxBytes).toBe(300);
    expect(out.summary).toBe(
      `Summarized ${byteLength(text)}-byte file: head ${byteLength(out.head ?? "")} bytes + ${out.structure?.length ?? 0} structure lines.`
    );
  });

  it("applies the default maxBytes of 20000 when omitted from a parsed input", async () => {
    const tool = createSummarizedReadTool();
    const parsed = tool.inputSchema.parse({ repoRoot, path: "small.txt" });
    expect(parsed.maxBytes).toBe(20000);
  });

  it("reports a missing file with exists=false", async () => {
    const tool = createSummarizedReadTool();
    const out = await tool.execute({ repoRoot, path: "nope.txt", maxBytes: 1000 }, {});
    expect(out.exists).toBe(false);
    expect(out.blockers).toEqual([]);
    expect(out.summary).toBe("File does not exist.");
  });

  it("blocks paths that escape the repository root", async () => {
    const tool = createSummarizedReadTool();
    const out = await tool.execute({ repoRoot, path: "../../etc/passwd", maxBytes: 1000 }, {});
    expect(out.exists).toBe(false);
    expect(out.blockers.length).toBeGreaterThan(0);
    expect(out.blockers[0]).toContain("escapes the repository root");
    expect(out.contents).toBeUndefined();
    expect(out.head).toBeUndefined();
  });

  it("blocks binary files (NUL byte in sample)", async () => {
    const buf = Buffer.concat([Buffer.from("prefix"), Buffer.from([0]), Buffer.from("suffix")]);
    await writeFile(join(repoRoot, "bin.dat"), buf);
    const tool = createSummarizedReadTool();
    const out = await tool.execute({ repoRoot, path: "bin.dat", maxBytes: 1000 }, {});
    expect(out.exists).toBe(true);
    expect(out.isBinary).toBe(true);
    expect(out.blockers.length).toBeGreaterThan(0);
    expect(out.contents).toBeUndefined();
  });

  it("blocks non-file targets", async () => {
    await mkdir(join(repoRoot, "adir"));
    const tool = createSummarizedReadTool();
    const out = await tool.execute({ repoRoot, path: "adir", maxBytes: 1000 }, {});
    expect(out.exists).toBe(true);
    expect(out.blockers).toContain("Target is not a regular file.");
    expect(out.contents).toBeUndefined();
  });

  it("blocks output that trips the sensitive-content policy", async () => {
    // Well-known AWS documentation example key matches the aws-access-key pattern.
    await writeFile(join(repoRoot, "leak.txt"), "key = AKIAIOSFODNN7EXAMPLE\n", "utf8");
    const tool = createSummarizedReadTool({ secretAllowList: [] });
    const out = await tool.execute({ repoRoot, path: "leak.txt", maxBytes: 1000 }, {});
    expect(out.exists).toBe(true);
    expect(out.blockers.length).toBeGreaterThan(0);
    expect(out.blockers[0]).toContain("sensitive");
    expect(out.contents).toBeUndefined();
    expect(out.head).toBeUndefined();
  });
});
