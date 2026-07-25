import { describe, expect, it } from "vitest";

import { lintSkillBody } from '../../src/skills/portableSkillAuthorLint.js';

describe("portableSkillAuthorLint — vendor-locked path tokens (§F410)", () => {
  describe("clean bodies (ok: true)", () => {
    it("returns ok:true with no warnings for a clean portable body", () => {
      const result = lintSkillBody("This skill uses a relative path to its own references/ directory.");
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns ok:true for an empty body", () => {
      const result = lintSkillBody("");
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns ok:true when ~/.config or generic home paths are used (not vendor-locked)", () => {
      const result = lintSkillBody("Config lives under ~/.config/guru or the project root.");
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns ok:true when ~/.guruharness is used (own harness, not vendor-locked)", () => {
      const result = lintSkillBody("The home profile is at ~/.guruharness/garage.");
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns ok:true when vendor names appear as prose, not paths", () => {
      const result = lintSkillBody("This skill works with Claude Code or Codex as the upstream harness.");
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("vendor-locked ~/.claude", () => {
    it("flags ~/.claude in prose", () => {
      const result = lintSkillBody("Load the config from ~/.claude/settings.json.");
      expect(result.ok).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.vendor).toBe("Claude Code");
      expect(result.warnings[0]!.token).toBe("~/.claude/");
      expect(result.warnings[0]!.hint).toContain("portable");
    });

    it("flags ~/.claude at end of line without trailing slash", () => {
      const result = lintSkillBody("See settings in ~/.claude");
      expect(result.ok).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.token).toBe("~/.claude");
    });

    it("flags multiple ~/.claude occurrences as separate warnings", () => {
      const result = lintSkillBody("Copy from ~/.claude/settings.json and ~/.claude/CLAUDE.md.");
      expect(result.ok).toBe(false);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings.every((w) => w.vendor === "Claude Code")).toBe(true);
    });
  });

  describe("vendor-locked ~/.codex", () => {
    it("flags ~/.codex in prose", () => {
      const result = lintSkillBody("Read rules from ~/.codex/instructions.md.");
      expect(result.ok).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.vendor).toBe("OpenAI Codex");
      expect(result.warnings[0]!.token).toBe("~/.codex/");
    });

    it("flags ~/.codex at end of line", () => {
      const result = lintSkillBody("The agent config is at ~/.codex");
      expect(result.ok).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.vendor).toBe("OpenAI Codex");
    });
  });
});
