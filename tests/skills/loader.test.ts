import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills, loadSkill, resolveSkillReferencePath } from "../../src/skills/loader.js";
import { createListSkillsTool, createLoadSkillTool } from "../../src/tools/builtins/skillLoaderTools.js";
import { createToolRegistry, executeRegisteredTool } from "../../src/tools/registry.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("discoverSkills", () => {
  it("should discover SKILL.md files with frontmatter metadata", () => {
    const root = createSkillTree();

    const catalog = discoverSkills({ directories: ["skills"], cwd: root });

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        id: "typescript-dev",
        name: "TypeScript Development",
        description: "TypeScript development.",
        allowedTools: ["Read", "Edit", "Bash"]
      })
    ]);
    expect(catalog.skills[0]?.skillFile).toMatch(/SKILL\.md$/);
  });

  it("should report missing configured skill directories without throwing", () => {
    const root = makeTempDirectory();

    const catalog = discoverSkills({ directories: ["missing-skills"], cwd: root });

    expect(catalog.skills).toEqual([]);
    expect(catalog.diagnostics[0]).toContain("Skill directory not found");
  });

  it("should preserve comma-containing scalar frontmatter values", () => {
    const root = makeTempDirectory();
    const skillDirectory = join(root, "skills", "writing");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      join(skillDirectory, "SKILL.md"),
      "---\nname: writing\ndescription: Write clear, concise, useful docs.\nallowed-tools: Read, Write\n---\n# Writing\n"
    );

    const catalog = discoverSkills({ directories: ["skills"], cwd: root });

    expect(catalog.skills[0]?.description).toBe("Write clear, concise, useful docs.");
    expect(catalog.skills[0]?.allowedTools).toEqual(["Read", "Write"]);
  });

  it("should reject duplicate skill ids", () => {
    const root = createSkillTree();
    mkdirSync(join(root, "skills", "duplicate"));
    writeFileSync(
      join(root, "skills", "duplicate", "SKILL.md"),
      "---\nname: typescript-dev\ndescription: Duplicate.\n---\n# Duplicate\n"
    );

    expect(() => discoverSkills({ directories: ["skills"], cwd: root })).toThrow("Duplicate skill id(s): typescript-dev");
  });
});

describe("loadSkill", () => {
  it("should load the skill document content and parsed frontmatter", () => {
    const root = createSkillTree();

    const skill = loadSkill({ directories: ["skills"], cwd: root, skillId: "typescript-dev" });

    expect(skill.manifest.id).toBe("typescript-dev");
    expect(skill.content).toContain("# TypeScript Development");
    expect(skill.frontmatter).toMatchObject({ name: "typescript-dev" });
  });

  it("should resolve relative references against the skill directory", () => {
    const root = createSkillTree();

    const referencePath = resolveSkillReferencePath({
      directories: ["skills"],
      cwd: root,
      skillId: "typescript-dev",
      reference: "patterns.md"
    });

    expect(referencePath).toBe(join(root, "skills", "typescript-dev", "patterns.md"));
  });

  it("should reject skill references that escape the skill directory", () => {
    const root = createSkillTree();

    expect(() =>
      resolveSkillReferencePath({
        directories: ["skills"],
        cwd: root,
        skillId: "typescript-dev",
        reference: "../secret.md"
      })
    ).toThrow("Skill reference escapes skill directory");
  });
});

describe("skill loader tools", () => {
  it("should expose catalog listing and skill loading through the tool registry", async () => {
    const root = createSkillTree();
    const registry = createToolRegistry([
      createListSkillsTool({ directories: ["skills"], cwd: root }),
      createLoadSkillTool({ directories: ["skills"], cwd: root })
    ]);

    const catalogObservation = await executeRegisteredTool(registry, "skills.catalog.list", {});
    const skillObservation = await executeRegisteredTool(registry, "skill.document.load", { skillId: "typescript-dev" });

    expect(catalogObservation.status).toBe("succeeded");
    expect(catalogObservation.output).toMatchObject({ skills: [expect.objectContaining({ id: "typescript-dev" })] });
    expect(skillObservation.status).toBe("succeeded");
    expect(skillObservation.output).toMatchObject({ manifest: { id: "typescript-dev" } });
  });
});

function createSkillTree(): string {
  const root = makeTempDirectory();
  const skillDirectory = join(root, "skills", "typescript-dev");
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, "SKILL.md"),
    [
      "---",
      "name: typescript-dev",
      "description: TypeScript development.",
      "allowed-tools: Read, Edit, Bash",
      "---",
      "# TypeScript Development",
      "",
      "Use this skill when writing TypeScript.",
      ""
    ].join("\n")
  );
  writeFileSync(join(skillDirectory, "patterns.md"), "# Patterns\n");

  return root;
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-skills-"));
  tempDirectories.push(directory);

  return directory;
}
