import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSkillRoots,
  type SkillRootDiscoveryOptions
} from '../../src/skills/skillRootDiscovery.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("discoverSkillRoots", () => {
  it("discovers ordered candidates from home and project roots", () => {
    const { home, project, options } = makeRoots();

    const result = discoverSkillRoots(options);

    expect(result.roots.map((root) => root.path)).toEqual([home, project]);
    expect(result.roots.map((root) => root.origin)).toEqual(["home", "project"]);
  });

  it("loads home skills even when project skills are gated off by allowProjectSkills=false", () => {
    const { home, project, options } = makeRoots({ allowProjectSkills: false });

    writeSkill(home, "home-skill");
    writeSkill(project, "project-skill");

    const result = discoverSkillRoots(options);

    expect(result.loadSet.map((root) => root.path)).toEqual([home]);
    expect(result.gatedRoots.map((root) => root.path)).toEqual([project]);
    expect(result.skillIds()).toEqual(["home-skill"]);
    // The project skill exists on disk but must NOT be in the load set.
    expect(result.skillIds()).not.toContain("project-skill");
    expect(result.diagnostics.some((d) => /project skill root gated \(allowProjectSkills=false\)/i.test(d))).toBe(true);
  });

  it("gates project skills when the project root is explicitly untrusted", () => {
    const { home, project, options } = makeRoots({ allowProjectSkills: true, projectTrusted: false });

    writeSkill(home, "home-skill");
    writeSkill(project, "project-skill");

    const result = discoverSkillRoots(options);

    expect(result.loadSet.map((root) => root.path)).toEqual([home]);
    expect(result.gatedRoots.map((root) => root.path)).toEqual([project]);
    expect(result.skillIds()).toEqual(["home-skill"]);
    expect(result.gatedRoots[0]?.reason).toBe("untrusted");
    expect(result.diagnostics.some((d) => d.includes("untrusted"))).toBe(true);
  });

  it("does not fail open: a project root with undefined projectTrusted and allowProjectSkills=false is gated", () => {
    const { home, project, options } = makeRoots();

    writeSkill(home, "home-skill");
    writeSkill(project, "project-skill");

    const result = discoverSkillRoots(options);

    // Default policy is deny project skills until trust is explicit — no fail-open.
    expect(result.loadSet.map((root) => root.path)).toEqual([home]);
    expect(result.gatedRoots.map((root) => root.path)).toEqual([project]);
    expect(result.gatedRoots[0]?.reason).toBe("allowProjectSkills=false");
    expect(result.skillIds()).not.toContain("project-skill");
  });

  it("loads both home and project skills when project skills are allowed and the project root is trusted", () => {
    const { home, project, options } = makeRoots({ allowProjectSkills: true, projectTrusted: true });

    writeSkill(home, "home-skill");
    writeSkill(project, "project-skill");

    const result = discoverSkillRoots(options);

    expect(result.loadSet.map((root) => root.path)).toEqual([home, project]);
    expect(result.gatedRoots).toEqual([]);
    expect(result.skillIds()).toEqual(["home-skill", "project-skill"]);
  });

  it("allowProjectSkills=false gates project skills even when the project root is trusted", () => {
    const { home, project, options } = makeRoots({ allowProjectSkills: false, projectTrusted: true });

    writeSkill(home, "home-skill");
    writeSkill(project, "project-skill");

    const result = discoverSkillRoots(options);

    expect(result.loadSet.map((root) => root.path)).toEqual([home]);
    expect(result.gatedRoots.map((root) => root.path)).toEqual([project]);
    expect(result.skillIds()).toEqual(["home-skill"]);
  });

  it("preserves home-first ordering in the load set when additional home roots are present", () => {
    const extraHome = makeTempDirectory();
    writeSkill(extraHome, "extra-home-skill");
    const { home, project, options } = makeRoots({ allowProjectSkills: true, projectTrusted: true, extraHomeRoots: [extraHome] });

    writeSkill(home, "home-skill");
    writeSkill(project, "project-skill");

    const result = discoverSkillRoots(options);

    expect(result.roots.map((root) => root.origin)).toEqual(["home", "home", "project"]);
    expect(result.loadSet.map((root) => root.origin)).toEqual(["home", "home", "project"]);
    expect(result.skillIds()).toEqual(["extra-home-skill", "home-skill", "project-skill"]);
  });
});

function makeRoots(overrides: Partial<{
  allowProjectSkills: boolean;
  projectTrusted: boolean | undefined;
  extraHomeRoots: string[];
}> = {}): { home: string; project: string; options: SkillRootDiscoveryOptions } {
  const home = makeTempDirectory();
  const project = makeTempDirectory();
  mkdirSync(join(home, "skills"), { recursive: true });
  mkdirSync(join(project, "skills"), { recursive: true });

  const options: SkillRootDiscoveryOptions = {
    homeRoots: overrides.extraHomeRoots ? [home, ...overrides.extraHomeRoots] : [home],
    projectRoots: [project],
    ...(overrides.allowProjectSkills === undefined ? {} : { allowProjectSkills: overrides.allowProjectSkills }),
    ...(overrides.projectTrusted === undefined ? {} : { projectTrusted: overrides.projectTrusted })
  };

  return { home, project, options };
}

function writeSkill(root: string, name: string): void {
  const directory = join(root, "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n# ${name}\n`
  );
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-skill-roots-"));
  tempDirectories.push(directory);

  return directory;
}
