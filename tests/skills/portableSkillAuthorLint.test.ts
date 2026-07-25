import { describe, expect, it } from "vitest";

import { lintPortableSkill, type VendorPathWarning } from '../../src/skills/portableSkillAuthorLint.js';

describe("lintPortableSkill", () => {
  it("returns no warnings for a fully portable skill body", () => {
    const warnings = lintPortableSkill("Use ~/.guruharness/skills for portable skill storage.");

    expect(warnings).toEqual([]);
  });

  it("returns no warnings when body contains no path tokens at all", () => {
    const warnings = lintPortableSkill("# My Skill\n\nThis skill helps with code review.");

    expect(warnings).toEqual([]);
  });

  it("returns no warnings for generic home-directory paths that are not vendor-locked", () => {
    const warnings = lintPortableSkill("Store data in ~/projects/my-skill or ~/.gitconfig.");

    expect(warnings).toEqual([]);
  });

  it("flags ~/.claude as an Anthropic Claude vendor-locked path", () => {
    const warnings = lintPortableSkill("Store skills in ~/.claude/skills/.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      vendor: "Anthropic Claude",
    });
    expect(warnings[0]?.message).toContain("~/.claude");
  });

  it("flags ~/.codex as an OpenAI Codex vendor-locked path", () => {
    const warnings = lintPortableSkill("Read from ~/.codex/settings.json for configuration.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.vendor).toBe("OpenAI Codex");
  });

  it("flags ~/.anthropic as an Anthropic vendor-locked path", () => {
    const warnings = lintPortableSkill("Copy ~/.anthropic/config into place.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.vendor).toBe("Anthropic");
  });

  it("flags ~/.openai as an OpenAI vendor-locked path", () => {
    const warnings = lintPortableSkill("cat ~/.openai/credentials");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.vendor).toBe("OpenAI");
  });

  it("flags ~/.config/claude as a Claude XDG config vendor-locked path", () => {
    const warnings = lintPortableSkill("Check ~/.config/claude/settings.json.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.vendor).toBe("Anthropic Claude");
  });

  it("flags $HOME/.claude as a Claude vendor-locked path (env-var form)", () => {
    const warnings = lintPortableSkill("Source \$HOME/.claude/skills/my-skill.md.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.vendor).toBe("Anthropic Claude");
  });

  it("flags multiple vendor-locked paths in the same body", () => {
    const warnings = lintPortableSkill(
      "First check ~/.claude/skills, then fall back to ~/.codex/tools."
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.vendor).toBe("Anthropic Claude");
    expect(warnings[1]?.vendor).toBe("OpenAI Codex");
  });

  it("deduplicates repeated mentions of the same vendor path", () => {
    const warnings = lintPortableSkill(
      "~/.claude is great. Use ~/.claude for everything."
    );

    // Same vendor path mentioned twice — only one warning
    expect(warnings).toHaveLength(1);
  });

  it("each warning includes a suggestion for a portable alternative", () => {
    const warnings = lintPortableSkill("Load from ~/.claude/skills/.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.suggestion).toBeTruthy();
    expect(warnings[0]?.suggestion).toContain("~/.guruharness");
  });

  it("returns warnings with the matched path token for author context", () => {
    const warnings = lintPortableSkill("See ~/.claude/skills/my-skill.md for details.");

    expect(warnings[0]?.path).toBe("~/.claude");
  });

  it("is case-sensitive for vendor paths (unix convention)", () => {
    const warnings = lintPortableSkill("Use ~/.Claude for config.");

    // ~/.Claude is not the same as ~/.claude on Unix — no flag
    expect(warnings).toEqual([]);
  });

  it("flags ~/.config/codex as an OpenAI Codex XDG vendor-locked path", () => {
    const warnings = lintPortableSkill("Read ~/.config/codex/config.toml.");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.vendor).toBe("OpenAI Codex");
  });
});
