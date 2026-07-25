import { describe, expect, it } from "vitest";

import { detect, MAGIC_KEYWORDS, type MagicKeyword } from '../../src/session/magicKeywordTurnFlags.js';

describe("magicKeywordTurnFlags", () => {
  describe("MAGIC_KEYWORDS", () => {
    it("contains the three canonical keywords", () => {
      expect(MAGIC_KEYWORDS).toEqual(["ultrathink", "orchestrate", "workflowz"]);
    });

    it("is readonly", () => {
      // TypeScript const assertion + readonly tuple — verify at type level
      const keywords: readonly string[] = MAGIC_KEYWORDS;
      expect(keywords.length).toBe(3);
    });
  });

  describe("detect", () => {
    // ── prose hits ──────────────────────────────────────────

    it("detects ultrathink in plain prose", () => {
      const text = "I think we should use ultrathink mode for this task.";
      expect(detect(text)).toEqual(["ultrathink"]);
    });

    it("detects orchestrate in plain prose", () => {
      const text = "Let's orchestrate the build with multiple agents.";
      expect(detect(text)).toEqual(["orchestrate"]);
    });

    it("detects workflowz in plain prose", () => {
      const text = "Use workflowz to fan out the review.";
      expect(detect(text)).toEqual(["workflowz"]);
    });

    it("detects multiple keywords in the same text", () => {
      const text = "Run ultrathink first, then orchestrate via workflowz.";
      const result = detect(text);
      expect(result).toContain("ultrathink");
      expect(result).toContain("orchestrate");
      expect(result).toContain("workflowz");
      expect(result.length).toBe(3);
    });

    it("returns each keyword only once even with multiple occurrences", () => {
      const text = "ultrathink here and ultrathink there and ultrathink everywhere";
      expect(detect(text)).toEqual(["ultrathink"]);
    });

    // ── case insensitivity ──────────────────────────────────

    it("matches keywords case-insensitively", () => {
      expect(detect("Use ULTRATHINK now")).toEqual(["ultrathink"]);
      expect(detect("ORCHESTRATE this")).toEqual(["orchestrate"]);
      expect(detect("WorkFlowZ please")).toEqual(["workflowz"]);
    });

    it("matches mixed-case keywords", () => {
      expect(detect("UltraThink mode engaged")).toEqual(["ultrathink"]);
      expect(detect("Orchestrate the agents")).toEqual(["orchestrate"]);
    });

    // ── fenced code ignores ─────────────────────────────────

    it("does NOT detect keywords inside fenced code blocks (```)", () => {
      const text = "Here is some prose.\n```\nuse ultrathink\norchestrate this\nworkflowz here\n```\nBack to prose.";
      expect(detect(text)).toEqual([]);
    });

    it("does NOT detect keywords in fenced code with language tag", () => {
      const text = "Before code.\n```typescript\nconst mode = 'ultrathink';\nconst action = 'orchestrate';\n```\nAfter code.";
      expect(detect(text)).toEqual([]);
    });

    it("detects keywords in prose but NOT in adjacent fenced code blocks", () => {
      const text = [
        "Let's use ultrathink for this.",
        "",
        "```ts",
        "// ultrathink is not detected here",
        "const x = 1;",
        "```",
        "",
        "Then we orchestrate the rest."
      ].join("\n");

      const result = detect(text);
      expect(result).toContain("ultrathink");
      expect(result).toContain("orchestrate");
      expect(result).not.toContain("workflowz");
      expect(result.length).toBe(2);
    });

    it("ignores multiple fenced code blocks", () => {
      const text = [
        "Prose with workflowz.",
        "",
        "```python",
        "# ultrathink in python",
        "print('hello')",
        "```",
        "",
        "More prose.",
        "",
        "```bash",
        "# orchestrate in bash",
        "echo done",
        "```",
        "",
        "End prose with ultrathink."
      ].join("\n");

      const result = detect(text);
      expect(result).toContain("ultrathink");
      expect(result).toContain("workflowz");
      expect(result).not.toContain("orchestrate");
      expect(result.length).toBe(2);
    });

    // ── unclosed fence: safe default ────────────────────────

    it("treats text after an unclosed fence as code (safe default)", () => {
      const text = "Prose with ultrathink.\n```\nuse ultrathink in code\norchestrate in code\nworkflowz in code\n(no closing fence)";
      // ultrathink appears in prose BEFORE the fence, so it should be detected
      // Everything after the unclosed ``` is treated as code
      const result = detect(text);
      expect(result).toEqual(["ultrathink"]);
    });

    it("handles fence at the very start of text", () => {
      const text = "```\nultrathink in code\norchestrate in code\n```\nProse with workflowz.";
      const result = detect(text);
      expect(result).toEqual(["workflowz"]);
    });

    // ── empty / edge cases ──────────────────────────────────

    it("returns empty array for empty text", () => {
      expect(detect("")).toEqual([]);
    });

    it("returns empty array when no keywords are present", () => {
      expect(detect("Just some normal prose with no magic words.")).toEqual([]);
    });

    it("returns empty array for text with only whitespace", () => {
      expect(detect("   \n\t\n  ")).toEqual([]);
    });

    // ── inline code is prose (only fenced blocks are excluded) ──

    it("detects keywords in inline backtick spans (not fenced code)", () => {
      const text = "Use `ultrathink` mode for this task.";
      // Inline code with single backticks is NOT a fenced code block — it's prose
      expect(detect(text)).toEqual(["ultrathink"]);
    });

    // ── partial / substring ─────────────────────────────────

    it("matches keywords as substrings within longer words", () => {
      // "ultrathink" is embedded in "ultrathinking"
      expect(detect("Enable ultrathinking mode")).toEqual(["ultrathink"]);
    });
  });

  // ── type-level checks ─────────────────────────────────────

  describe("types", () => {
    it("detect returns readonly MagicKeyword array", () => {
      const result = detect("use ultrathink");
      // Verifies the function compiles and returns the expected shape
      const typed: readonly MagicKeyword[] = result;
      expect(typed).toEqual(["ultrathink"]);
    });
  });
});
