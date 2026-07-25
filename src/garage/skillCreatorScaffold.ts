import { mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill creator scaffold (IDEA-F199-SKILL-CREATE — Skill Creator Scaffold).
 *
 * Generates the empty SKILL.md (front-matter + body template) for a named skill
 * inside a target directory. The fs surface is injectable so the same call can
 * run against an in-memory adapter in tests, and so the core can stay pure and
 * the file I/O detail stays behind an explicit boundary (vision §1.1, §1.2 —
 * keep the core owned and lightweight; this is garage/writer seam, not core).
 */

export interface ScaffoldFs {
  /** Recursively create the directory (and any parents). */
  readonly mkdirSync: (path: string) => void;
  /** Write the file (UTF-8). */
  readonly writeFileSync: (path: string, content: string) => void;
}

const defaultFs: ScaffoldFs = {
  mkdirSync: (path) => fsMkdirSync(path, { recursive: true }),
  writeFileSync: (path, content) => fsWriteFileSync(path, content, "utf8")
};

export interface ScaffoldSkillInput {
  /** Skill slug used as the directory name and the front-matter `name`. Must be non-empty and contain no path separators. */
  readonly name: string;
  /** Directory in which the skill subdirectory will be created (e.g. `~/.guruharness/skills` or a target project's `skills/`). */
  readonly dir: string;
  /** Optional fs seam; defaults to node:fs sync writes. */
  readonly fs?: ScaffoldFs;
}

export type ScaffoldSkillResult =
  | { readonly ok: true; readonly path: string; readonly name: string }
  | { readonly ok: false; readonly reason: string; readonly name: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/**
 * Validate a skill name: non-empty, no path separators or traversal, and matches
 * the convention the loader accepts (lowercase, dot/dash/underscore allowed).
 */
export function isValidSkillName(name: string): name is string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  if (trimmed.includes("..")) return false;
  return NAME_PATTERN.test(trimmed);
}

/**
 * Render the empty front-matter + body template for a new skill. The body is a
 * placeholder so the operator must write the actual instructions — no fabricated
 * content ships from the scaffold.
 */
export function renderSkillTemplate(name: string, description: string, allowedTools: string[]): string {
  const tools = allowedTools.map((tool) => `  - ${tool}`).join("\n");
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "allowed-tools:",
    tools.length > 0 ? tools : "  - Read",
    "---",
    "",
    `# ${name}`,
    "",
    "<!-- TODO: replace this scaffold with real instructions for this skill. -->",
    "",
    "## When to use",
    "",
    "Describe the trigger condition so the harness knows when to load this skill.",
    "",
    "## Workflow",
    "",
    "1. ",
    "",
    "## Guardrails",
    "",
    "- ",
    ""
  ].join("\n");
}

/**
 * Scaffold a skill under `dir`. Writes `<dir>/<name>/SKILL.md` with empty
 * front-matter + a body template the operator fills in. Returns a discriminated
 * result so callers can surface the failure without parsing strings.
 */
export function scaffoldSkill(input: ScaffoldSkillInput): ScaffoldSkillResult {
  const trimmedName = input.name.trim();
  if (!isValidSkillName(trimmedName)) {
    return {
      ok: false,
      reason:
        "Invalid skill name: must be non-empty, lowercase, start with alphanumeric, contain only [a-z0-9._-], and contain no path separators or traversal segments.",
      name: input.name
    };
  }

  const fsImpl = input.fs ?? defaultFs;
  const skillDir = join(input.dir, trimmedName);
  const skillFile = join(skillDir, "SKILL.md");

  fsImpl.mkdirSync(skillDir);

  const template = renderSkillTemplate(
    trimmedName,
    `TODO: describe when to use this skill.`,
    ["Read", "Bash", "Edit", "Write"]
  );
  fsImpl.writeFileSync(skillFile, template);

  return { ok: true, path: skillFile, name: trimmedName };
}
