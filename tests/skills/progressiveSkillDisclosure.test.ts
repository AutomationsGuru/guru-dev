import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProgressiveSkillDisclosure, SkillThinViewSchema, toThinView } from '../../src/skills/progressiveSkillDisclosure.js';

/**
 * Progressive skill disclosure (IDEA-F401-PROG-01 / R-WSH-PROG):
 *   - thin view = name + description only (NO body, NO content);
 *   - the full body loads once, on activate, and is cached (second activate does
 *     not re-read from disk).
 *
 * The skill body ("SECRET-BODY-MARKER") is planted on disk so the tests can prove
 * the thin path never carries it and the activate path loads it exactly once.
 */
const BODY_MARKER = "SECRET-BODY-MARKER-DO-NOT-LEAK-INTO-THIN-VIEW";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillTree(): string {
  const root = mkdtempSync(join(tmpdir(), "guru-prog-"));
  tempDirs.push(root);
  const skillDir = join(root, "skills", "typescript-dev");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: typescript-dev",
      "description: TypeScript development.",
      "allowed-tools: Read, Edit, Bash",
      "---",
      "# TypeScript Development",
      "",
      `Use this skill when writing TypeScript. ${BODY_MARKER}`,
      ""
    ].join("\n")
  );
  return root;
}

describe("progressiveSkillDisclosure — thin view (R-WSH-PROG: name+description only)", () => {
  it("listThin returns id + name + description for each skill", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });

    const thin = disclosure.listThin();

    expect(thin).toHaveLength(1);
    expect(thin[0]).toMatchObject({
      id: "typescript-dev",
      name: "TypeScript Development",
      description: "TypeScript development."
    });
  });

  it("the thin view carries NO body, NO content, NO skillFile (the disclosure boundary)", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });

    const thin = disclosure.listThin();
    const view = thin[0]!;

    // The body marker that lives on disk must never appear in the thin view.
    expect(JSON.stringify(view)).not.toContain(BODY_MARKER);
    // Structurally: only the three disclosure keys are present.
    expect(Object.keys(view).sort()).toEqual(["description", "id", "name"]);
    expect(view).not.toHaveProperty("body");
    expect(view).not.toHaveProperty("content");
    expect(view).not.toHaveProperty("skillFile");
    // And the strict schema certifies exactly that shape.
    expect(() => SkillThinViewSchema.parse({ ...view, body: "leaked" })).toThrow();
  });

  it("toThinView projects a manifest down to exactly id+name+description", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });
    // Build a full manifest-like object (with keys the thin view must drop) and
    // confirm toThinView keeps only the three disclosure keys.
    const full = {
      id: "typescript-dev",
      name: "TypeScript Development",
      description: "TypeScript development.",
      directory: "/should/be/dropped",
      skillFile: "/should/be/dropped/SKILL.md",
      allowedTools: ["Read"],
      kind: "native" as const,
      metadata: {}
    };

    const projected = toThinView(full);

    expect(projected).toEqual({
      id: "typescript-dev",
      name: "TypeScript Development",
      description: "TypeScript development."
    });
    expect(Object.keys(projected).sort()).toEqual(["description", "id", "name"]);
  });
});

describe("progressiveSkillDisclosure — activate loads the full body once and caches it", () => {
  it("activate returns the full SkillDocument with the body included", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });

    const { skill, fromCache } = disclosure.activate("typescript-dev");

    expect(fromCache).toBe(false);
    expect(skill.manifest.id).toBe("typescript-dev");
    expect(skill.body).toContain(BODY_MARKER); // full body is present after activate
    expect(skill.content).toContain(BODY_MARKER);
  });

  it("the second activate is served from the cache (no disk re-read) — fromCache: true", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });

    const first = disclosure.activate("typescript-dev");
    const second = disclosure.activate("typescript-dev");

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    // Same cached object identity: the body is loaded once.
    expect(second.skill).toBe(first.skill);
  });

  it("isCached / cachedSkillIds track which skills hold a cached body", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });

    expect(disclosure.isCached("typescript-dev")).toBe(false);
    expect(disclosure.cachedSkillIds()).toEqual([]);

    disclosure.activate("typescript-dev");

    expect(disclosure.isCached("typescript-dev")).toBe(true);
    expect(disclosure.cachedSkillIds()).toEqual(["typescript-dev"]);
  });

  it("activate throws on an unknown skill id (a deliberate move, not a silent fallthrough)", () => {
    const disclosure = new ProgressiveSkillDisclosure({ directories: ["skills"], cwd: skillTree() });

    expect(() => disclosure.activate("does-not-exist")).toThrow("Skill not found");
  });
});
