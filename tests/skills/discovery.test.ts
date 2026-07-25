import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSkillInjectPlan,
  discoverSkillsMultiRoot,
  listUserInvocableSkills,
  resolveSkillInvocation,
  resolveSkillRoots,
  type DiscoveredSkill
} from "../../src/skills/discovery.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.length = 0;
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guru-skill-discovery-"));
  tempDirectories.push(directory);
  return directory;
}

function writeSkill(root: string, id: string, frontmatter: string, body = `# ${id}\n`): string {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "SKILL.md");
  writeFileSync(file, `---\nname: ${id}\n${frontmatter}---\n${body}`);
  return file;
}

describe("resolveSkillRoots", () => {
  it("orders roots project → home → extra and resolves them absolute", () => {
    const base = makeTempDirectory();
    const roots = resolveSkillRoots({
      projectDirectory: join(base, "proj", "skills"),
      homeDirectory: join(base, "home", "skills"),
      extraDirectories: ["extra-skills"],
      cwd: base
    });

    expect(roots.map((root) => root.kind)).toEqual(["project", "home", "extra"]);
    expect(roots[0]?.directory).toBe(join(base, "proj", "skills"));
    expect(roots[1]?.directory).toBe(join(base, "home", "skills"));
    expect(roots[2]?.directory).toBe(join(base, "extra-skills"));
  });

  it("defaults the home root under the given home and skips a missing project root", () => {
    const base = makeTempDirectory();
    const roots = resolveSkillRoots({ home: base });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe("home");
    expect(roots[0]?.directory).toBe(join(base, ".guruharness", "skills"));
  });

  it("dedups a directory claimed by two roots, keeping the higher-precedence kind", () => {
    const base = makeTempDirectory();
    const shared = join(base, "skills");
    const roots = resolveSkillRoots({ projectDirectory: shared, homeDirectory: shared });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe("project");
  });
});

describe("resolveSkillInvocation", () => {
  function manifestWith(metadata: Record<string, unknown>): DiscoveredSkill["manifest"] {
    return {
      id: "demo",
      name: "Demo",
      description: "demo",
      directory: "/tmp/demo",
      skillFile: "/tmp/demo/SKILL.md",
      allowedTools: [],
      kind: "native",
      metadata
    };
  }

  it("defaults to user-invocable and model-invocable", () => {
    const invocation = resolveSkillInvocation(manifestWith({}));
    expect(invocation.userInvocable).toBe(true);
    expect(invocation.modelInvocable).toBe(true);
  });

  it("honors user-invocable: false", () => {
    expect(resolveSkillInvocation(manifestWith({ "user-invocable": "false" })).userInvocable).toBe(false);
    expect(resolveSkillInvocation(manifestWith({ "user-invocable": "false" })).modelInvocable).toBe(true);
  });

  it("honors disable-model-invocation: true", () => {
    expect(resolveSkillInvocation(manifestWith({ "disable-model-invocation": "true" })).modelInvocable).toBe(false);
    expect(resolveSkillInvocation(manifestWith({ "disable-model-invocation": "true" })).userInvocable).toBe(true);
  });

  it("accepts boolean frontmatter values too", () => {
    const invocation = resolveSkillInvocation(manifestWith({ "user-invocable": false, "disable-model-invocation": true }));
    expect(invocation.userInvocable).toBe(false);
    expect(invocation.modelInvocable).toBe(false);
  });
});

describe("discoverSkillsMultiRoot", () => {
  it("discovers across roots and lets the project root shadow home by id", () => {
    const base = makeTempDirectory();
    const projectRoot = join(base, "project", "skills");
    const homeRoot = join(base, "home", "skills");
    writeSkill(homeRoot, "shared-skill", "description: from home.\n");
    writeSkill(projectRoot, "shared-skill", "description: from project.\n");
    writeSkill(homeRoot, "home-only", "description: only at home.\n");

    const result = discoverSkillsMultiRoot({ projectDirectory: projectRoot, homeDirectory: homeRoot });

    const shared = result.skills.find((skill) => skill.manifest.id === "shared-skill");
    expect(shared?.manifest.description).toBe("from project.");
    expect(shared?.root).toBe("project");
    expect(result.skills.find((skill) => skill.manifest.id === "home-only")?.root).toBe("home");
    expect(result.diagnostics.some((d) => d.includes("Duplicate skill id 'shared-skill'"))).toBe(true);
  });

  it("tags each discovered skill with its invocation gates", () => {
    const base = makeTempDirectory();
    const homeRoot = join(base, "home", "skills");
    writeSkill(homeRoot, "model-off", "description: x.\ndisable-model-invocation: true\n");
    writeSkill(homeRoot, "user-off", "description: y.\nuser-invocable: false\n");

    const result = discoverSkillsMultiRoot({ homeDirectory: homeRoot });
    const modelOff = result.skills.find((skill) => skill.manifest.id === "model-off");
    const userOff = result.skills.find((skill) => skill.manifest.id === "user-off");

    expect(modelOff?.invocation.modelInvocable).toBe(false);
    expect(modelOff?.invocation.userInvocable).toBe(true);
    expect(userOff?.invocation.userInvocable).toBe(false);
    expect(userOff?.invocation.modelInvocable).toBe(true);
  });
});

describe("buildSkillInjectPlan", () => {
  function discovered(id: string, description: string, invocation?: { userInvocable?: boolean; modelInvocable?: boolean }): DiscoveredSkill {
    return {
      manifest: {
        id,
        name: id,
        description,
        directory: `/tmp/${id}`,
        skillFile: `/tmp/${id}/SKILL.md`,
        allowedTools: [],
        kind: "native",
        metadata: {}
      },
      root: "home",
      invocation: { userInvocable: invocation?.userInvocable ?? true, modelInvocable: invocation?.modelInvocable ?? true }
    };
  }

  it("emits manifest metadata, defers bodies, and is byte-bounded", () => {
    const skills = [discovered("a-skill", "Alpha."), discovered("b-skill", "Beta.")];
    const plan = buildSkillInjectPlan(skills);

    expect(plan.manifestEntries.map((entry) => entry.id)).toEqual(["a-skill", "b-skill"]);
    expect(plan.manifestEntries.every((entry) => entry.deferredBody)).toBe(true);
    expect(plan.block).toContain("a-skill");
    expect(plan.bytes).toBeGreaterThan(0);
    expect(plan.modelDisabled).toEqual([]);
  });

  it("excludes disable-model-invocation skills from the inject plan", () => {
    const skills = [discovered("on", "On."), discovered("off", "Off.", { modelInvocable: false })];
    const plan = buildSkillInjectPlan(skills);

    expect(plan.manifestEntries.map((entry) => entry.id)).toEqual(["on"]);
    expect(plan.modelDisabled).toEqual(["off"]);
    expect(plan.block).not.toContain("off");
  });

  it("defers overflow skills past the byte budget instead of dropping them silently", () => {
    const skills = [
      discovered("first", "One."),
      discovered("second", "Two."),
      discovered("third", "Three.")
    ];
    const plan = buildSkillInjectPlan(skills, { maxBytes: 40 });

    expect(plan.manifestEntries.length).toBeLessThan(3);
    expect(plan.deferred.length).toBe(3 - plan.manifestEntries.length);
    expect(plan.deferred.length).toBeGreaterThan(0);
  });

  it("caps the manifest tier at maxSkills", () => {
    const skills = Array.from({ length: 5 }, (_, index) => discovered(`skill-${index}`, `Desc ${index}.`));
    const plan = buildSkillInjectPlan(skills, { maxSkills: 2 });

    expect(plan.manifestEntries).toHaveLength(2);
    expect(plan.deferred).toHaveLength(3);
  });

  it("is deterministic (id-sorted) for prompt-cache stability", () => {
    const skills = [discovered("zeta", "Z."), discovered("alpha", "A."), discovered("mid", "M.")];
    const plan = buildSkillInjectPlan(skills);

    expect(plan.manifestEntries.map((entry) => entry.id)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("listUserInvocableSkills", () => {
  it("returns only user-invocable skills, id-sorted", () => {
    const base = makeTempDirectory();
    const homeRoot = join(base, "home", "skills");
    writeSkill(homeRoot, "visible", "description: shown.\n");
    writeSkill(homeRoot, "hidden", "description: hidden.\nuser-invocable: false\n");

    const result = discoverSkillsMultiRoot({ homeDirectory: homeRoot });
    const list = listUserInvocableSkills(result.skills);

    expect(list.map((skill) => skill.manifest.id)).toEqual(["visible"]);
  });
});
