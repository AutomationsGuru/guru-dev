import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills } from '../../src/skills/loader.js';
import { SkillCatalogSchema, SkillManifestSchema, type SkillManifest } from '../../src/skills/schemas.js';
import { isAutoLoad, listAutoLoad, listDrafts, stageOf } from '../../src/skills/skillPromotionStages.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guru-skill-stages-"));
  tempDirectories.push(directory);
  return directory;
}

function makeManifest(id: string, metadata: Record<string, unknown> = {}): SkillManifest {
  return SkillManifestSchema.parse({
    id,
    name: id,
    description: `${id} skill.`,
    directory: `/tmp/${id}`,
    skillFile: `/tmp/${id}/SKILL.md`,
    allowedTools: [],
    kind: "native",
    metadata
  });
}

function writeSkill(root: string, id: string, frontmatter: string): void {
  const directory = join(root, "skills", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `${frontmatter}# ${id}\n`);
}

describe("stageOf", () => {
  it("returns draft for a skill whose frontmatter marks stage: draft", () => {
    expect(stageOf(makeManifest("wip", { stage: "draft" }))).toBe("draft");
    expect(isAutoLoad(makeManifest("wip", { stage: "draft" }))).toBe(false);
  });

  it("returns promoted for a skill whose frontmatter marks stage: promoted", () => {
    expect(stageOf(makeManifest("ready", { stage: "promoted" }))).toBe("promoted");
    expect(isAutoLoad(makeManifest("ready", { stage: "promoted" }))).toBe(true);
  });

  it("defaults to promoted when no stage is set (existing skills keep auto-loading)", () => {
    expect(stageOf(makeManifest("legacy"))).toBe("promoted");
  });

  it("treats an unrecognized stage value as promoted (opt-out must be explicit)", () => {
    expect(stageOf(makeManifest("typo", { stage: "hidden" }))).toBe("promoted");
    expect(stageOf(makeManifest("weird", { stage: 42 }))).toBe("promoted");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(stageOf(makeManifest("caps", { stage: " Draft " }))).toBe("draft");
    expect(stageOf(makeManifest("caps2", { stage: "PROMOTED" }))).toBe("promoted");
  });
});

describe("listAutoLoad / listDrafts", () => {
  it("ACCEPTANCE: drafts are excluded from auto-load; promoted are included", () => {
    const catalog = SkillCatalogSchema.parse({
      skills: [makeManifest("alpha"), makeManifest("beta", { stage: "draft" }), makeManifest("gamma", { stage: "promoted" })],
      directories: [],
      diagnostics: []
    });

    expect(listAutoLoad(catalog).map((skill) => skill.id)).toEqual(["alpha", "gamma"]);
    expect(listDrafts(catalog).map((skill) => skill.id)).toEqual(["beta"]);
  });

  it("returns every skill when none are drafted", () => {
    const catalog = SkillCatalogSchema.parse({
      skills: [makeManifest("one"), makeManifest("two")],
      directories: [],
      diagnostics: []
    });

    expect(listAutoLoad(catalog)).toHaveLength(2);
    expect(listDrafts(catalog)).toEqual([]);
  });

  it("returns an empty auto-load list when every skill is drafted", () => {
    const catalog = SkillCatalogSchema.parse({
      skills: [makeManifest("one", { stage: "draft" }), makeManifest("two", { stage: "draft" })],
      directories: [],
      diagnostics: []
    });

    expect(listAutoLoad(catalog)).toEqual([]);
    expect(listDrafts(catalog)).toHaveLength(2);
  });
});

describe("stage via discoverSkills (frontmatter integration)", () => {
  it("a SKILL.md with stage: draft in frontmatter is excluded from listAutoLoad", () => {
    const root = makeTempDirectory();
    writeSkill(root, "ready-skill", "---\nname: ready-skill\ndescription: Ready.\n---\n");
    writeSkill(root, "wip-skill", "---\nname: wip-skill\ndescription: Not ready.\nstage: draft\n---\n");

    const catalog = discoverSkills({ directories: ["skills"], cwd: root });

    expect(catalog.diagnostics).toEqual([]);
    expect(listAutoLoad(catalog).map((skill) => skill.id)).toEqual(["ready-skill"]);
    expect(listDrafts(catalog).map((skill) => skill.id)).toEqual(["wip-skill"]);
  });
});
