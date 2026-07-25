import { describe, expect, it } from "vitest";

import type { SkillManifest } from '../../src/skills/schemas.js';
import { parseSkillTriggers, SkillTriggerContextSchema } from '../../src/skills/skillTriggers.js';
import { matchSkillTriggers } from '../../src/skills/skillTriggerMatch.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSkill(id: string, metadata: Record<string, unknown> = {}): SkillManifest {
  return {
    id,
    name: `Skill ${id}`,
    description: `Test skill ${id}.`,
    directory: `/tmp/skills/${id}`,
    skillFile: `/tmp/skills/${id}/SKILL.md`,
    allowedTools: [],
    kind: "native",
    metadata
  };
}

// ── parseSkillTriggers ───────────────────────────────────────────────

describe("parseSkillTriggers", () => {
  it("returns empty array when triggers key is absent", () => {
    expect(parseSkillTriggers({})).toEqual([]);
  });

  it("returns empty array when triggers is null", () => {
    expect(parseSkillTriggers({ triggers: null })).toEqual([]);
  });

  it("returns empty array when triggers is not an array", () => {
    expect(parseSkillTriggers({ triggers: "not-an-array" })).toEqual([]);
  });

  it("parses a valid pathGlob trigger", () => {
    const triggers = parseSkillTriggers({
      triggers: [{ type: "pathGlob", glob: "*.ts" }]
    });
    expect(triggers).toEqual([{ type: "pathGlob", glob: "*.ts" }]);
  });

  it("parses a valid keyword trigger", () => {
    const triggers = parseSkillTriggers({
      triggers: [{ type: "keyword", keyword: "typescript" }]
    });
    expect(triggers).toEqual([{ type: "keyword", keyword: "typescript" }]);
  });

  it("parses a valid command trigger", () => {
    const triggers = parseSkillTriggers({
      triggers: [{ type: "command", command: "review" }]
    });
    expect(triggers).toEqual([{ type: "command", command: "review" }]);
  });

  it("parses multiple triggers", () => {
    const triggers = parseSkillTriggers({
      triggers: [
        { type: "pathGlob", glob: "*.ts" },
        { type: "keyword", keyword: "typescript" }
      ]
    });
    expect(triggers).toHaveLength(2);
  });

  it("returns empty array when trigger has unknown type (safeParse failure)", () => {
    const triggers = parseSkillTriggers({
      triggers: [{ type: "unknown", foo: "bar" }]
    });
    expect(triggers).toEqual([]);
  });

  it("returns empty array when one trigger is invalid (all-or-nothing parse)", () => {
    const triggers = parseSkillTriggers({
      triggers: [
        { type: "pathGlob", glob: "*.ts" },
        { type: "keyword" } // missing keyword field
      ]
    });
    expect(triggers).toEqual([]);
  });
});

// ── matchSkillTriggers: always-eligible (no triggers) ─────────────────

describe("matchSkillTriggers — always-eligible", () => {
  it("includes skills with no triggers (legacy always-on)", () => {
    const skill = makeSkill("legacy", { description: "Always on." });
    const result = matchSkillTriggers([skill], {});
    expect(result).toEqual([skill]);
  });

  it("includes skills with empty triggers array", () => {
    const skill = makeSkill("empty-trig", { triggers: [] });
    const result = matchSkillTriggers([skill], {});
    expect(result).toEqual([skill]);
  });

  it("filters correctly: legacy always-on vs triggered", () => {
    const always = makeSkill("always", {});
    const triggered = makeSkill("triggered", {
      triggers: [{ type: "keyword", keyword: "react" }]
    });
    const result = matchSkillTriggers([always, triggered], { message: "typescript" });
    expect(result).toEqual([always]); // triggered doesn't match, always does
  });
});

// ── matchSkillTriggers: pathGlob ─────────────────────────────────────

describe("matchSkillTriggers — pathGlob", () => {
  it("matches exact path", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "pathGlob", glob: "src/index.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "src/index.ts" });
    expect(result).toEqual([skill]);
  });

  it("matches single-star glob", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "pathGlob", glob: "*.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "index.ts" });
    expect(result).toEqual([skill]);
  });

  it("does not match when extension differs", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "pathGlob", glob: "*.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "index.js" });
    expect(result).toEqual([]);
  });

  it("matches double-star globstar across directories", () => {
    const skill = makeSkill("deep", {
      triggers: [{ type: "pathGlob", glob: "src/**/*.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "src/a/b/c/file.ts" });
    expect(result).toEqual([skill]);
  });

  it("does not match double-star when extension differs", () => {
    const skill = makeSkill("deep", {
      triggers: [{ type: "pathGlob", glob: "src/**/*.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "src/a/b/file.js" });
    expect(result).toEqual([]);
  });

  it("does not match when currentPath is absent", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "pathGlob", glob: "*.ts" }]
    });
    const result = matchSkillTriggers([skill], {});
    expect(result).toEqual([]);
  });

  it("matches globstar at root (no segment restriction)", () => {
    const skill = makeSkill("any-ts", {
      triggers: [{ type: "pathGlob", glob: "**/*.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "file.ts" });
    expect(result).toEqual([skill]);
  });

  it("normalizes backslashes to forward slashes", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "pathGlob", glob: "src/**/*.ts" }]
    });
    const result = matchSkillTriggers([skill], { currentPath: "src\\a\\b\\file.ts" });
    expect(result).toEqual([skill]);
  });
});

// ── matchSkillTriggers: keyword ──────────────────────────────────────

describe("matchSkillTriggers — keyword", () => {
  it("matches when keyword appears in message", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "keyword", keyword: "typescript" }]
    });
    const result = matchSkillTriggers([skill], { message: "Help me write TypeScript code." });
    expect(result).toEqual([skill]);
  });

  it("matches case-insensitively", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "keyword", keyword: "TypeScript" }]
    });
    const result = matchSkillTriggers([skill], { message: "write TYPESCRIPT code" });
    expect(result).toEqual([skill]);
  });

  it("does not match when keyword absent from message", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "keyword", keyword: "python" }]
    });
    const result = matchSkillTriggers([skill], { message: "Write some TypeScript." });
    expect(result).toEqual([]);
  });

  it("does not match when message is absent", () => {
    const skill = makeSkill("ts", {
      triggers: [{ type: "keyword", keyword: "typescript" }]
    });
    const result = matchSkillTriggers([skill], {});
    expect(result).toEqual([]);
  });

  it("does not match on partial word boundaries (substring match)", () => {
    // "script" is a substring of "typescript" — this IS a match
    // by design (case-insensitive includes). Test that it works.
    const skill = makeSkill("sub", {
      triggers: [{ type: "keyword", keyword: "script" }]
    });
    const result = matchSkillTriggers([skill], { message: "typescript" });
    expect(result).toEqual([skill]);
  });
});

// ── matchSkillTriggers: command ──────────────────────────────────────

describe("matchSkillTriggers — command", () => {
  it("matches exact command name", () => {
    const skill = makeSkill("review", {
      triggers: [{ type: "command", command: "review" }]
    });
    const result = matchSkillTriggers([skill], { command: "review" });
    expect(result).toEqual([skill]);
  });

  it("matches case-insensitively", () => {
    const skill = makeSkill("review", {
      triggers: [{ type: "command", command: "Review" }]
    });
    const result = matchSkillTriggers([skill], { command: "REVIEW" });
    expect(result).toEqual([skill]);
  });

  it("trims whitespace from context command", () => {
    const skill = makeSkill("review", {
      triggers: [{ type: "command", command: "review" }]
    });
    const result = matchSkillTriggers([skill], { command: "  review  " });
    expect(result).toEqual([skill]);
  });

  it("does not match different command", () => {
    const skill = makeSkill("build", {
      triggers: [{ type: "command", command: "build" }]
    });
    const result = matchSkillTriggers([skill], { command: "review" });
    expect(result).toEqual([]);
  });

  it("does not match when command context is absent", () => {
    const skill = makeSkill("build", {
      triggers: [{ type: "command", command: "build" }]
    });
    const result = matchSkillTriggers([skill], {});
    expect(result).toEqual([]);
  });
});

// ── matchSkillTriggers: OR semantics (any trigger match) ─────────────

describe("matchSkillTriggers — OR semantics", () => {
  it("matches if any one trigger matches (OR, not AND)", () => {
    const skill = makeSkill("multi", {
      triggers: [
        { type: "keyword", keyword: "python" },
        { type: "pathGlob", glob: "*.ts" }
      ]
    });
    // keyword doesn't match, but pathGlob does
    const result = matchSkillTriggers([skill], {
      message: "Write some code.",
      currentPath: "index.ts"
    });
    expect(result).toEqual([skill]);
  });

  it("excludes when no trigger matches", () => {
    const skill = makeSkill("multi", {
      triggers: [
        { type: "keyword", keyword: "python" },
        { type: "command", command: "deploy" }
      ]
    });
    const result = matchSkillTriggers([skill], {
      message: "TypeScript help",
      command: "review"
    });
    expect(result).toEqual([]);
  });
});

// ── SkillTriggerContext schema ────────────────────────────────────────

describe("SkillTriggerContext schema", () => {
  it("accepts empty object", () => {
    expect(SkillTriggerContextSchema.parse({})).toEqual({});
  });

  it("accepts full context", () => {
    const ctx = SkillTriggerContextSchema.parse({
      currentPath: "src/index.ts",
      message: "Help with TypeScript.",
      command: "build"
    });
    expect(ctx).toEqual({
      currentPath: "src/index.ts",
      message: "Help with TypeScript.",
      command: "build"
    });
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => SkillTriggerContextSchema.parse({ extra: true })).toThrow();
  });
});
