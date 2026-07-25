import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverTrustedSkillRoots,
  type SkillRoot,
  type SkillRootTrustFlags
} from '../../src/skills/skillRootTrustGate.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("discoverTrustedSkillRoots — trust gate", () => {
  it("admits home roots and trusted project roots when allowProjectSkills is true", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ],
      flags: { allowProjectSkills: true }
    });

    expect(result.loadSet.map((r) => r.path)).toEqual([homeRoot, projectRoot]);
    expect(result.gatedRoots).toEqual([]);
    expect(result.skillIds()).toEqual(["home-skill", "project-skill"]);
  });

  it("skips project skills when allowProjectSkills is false (project skill present on disk but not in the load set)", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ],
      flags: { allowProjectSkills: false }
    });

    // Home skill still loads.
    expect(result.loadSet.map((r) => r.path)).toEqual([homeRoot]);
    expect(result.skillIds()).toEqual(["home-skill"]);

    // Project root gated with a policy-deny reason; project skill is NOT in the load set.
    expect(result.gatedRoots).toHaveLength(1);
    expect(result.gatedRoots[0]).toMatchObject({ path: projectRoot, reason: "allowProjectSkills=false" });
    expect(result.skillIds()).not.toContain("project-skill");
    expect(result.diagnostics.some((d) => d.includes(projectRoot) && d.includes("allowProjectSkills"))).toBe(true);
  });

  it("gates a project root when trusted is not the explicit value true (no fail-open)", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project" }
      ],
      flags: { allowProjectSkills: true }
    });

    // trusted defaulted to false → project root gated even though the policy allows project skills.
    expect(result.loadSet.map((r) => r.path)).toEqual([homeRoot]);
    expect(result.gatedRoots[0]).toMatchObject({ path: projectRoot, reason: "untrusted" });
    expect(result.skillIds()).not.toContain("project-skill");
  });

  it("gates a project root that is explicitly untrusted", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: false }
      ],
      flags: { allowProjectSkills: true }
    });

    expect(result.loadSet.map((r) => r.path)).toEqual([homeRoot]);
    expect(result.gatedRoots[0]).toMatchObject({ path: projectRoot, reason: "untrusted" });
  });

  it("defaults allowProjectSkills to false (deny-default; no fail-open)", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    // flags omitted entirely → allowProjectSkills defaults to false → project gated.
    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ]
    });

    expect(result.loadSet.map((r) => r.path)).toEqual([homeRoot]);
    expect(result.gatedRoots[0]).toMatchObject({ path: projectRoot, reason: "allowProjectSkills=false" });
  });

  it("admits home roots regardless of project policy (home is always trusted)", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ],
      flags: { allowProjectSkills: false }
    });

    expect(result.loadSet.some((r) => r.path === homeRoot && r.origin === "home")).toBe(true);
    expect(result.skillIds()).toContain("home-skill");
    expect(result.skillIds()).not.toContain("project-skill");
  });

  it("policy deny overrides trust: trusted project root is still gated when allowProjectSkills is false", () => {
    const { homeRoot, projectRoot } = createTwoRoots();

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ],
      flags: { allowProjectSkills: false }
    });

    expect(result.loadSet.map((r) => r.path)).toEqual([homeRoot]);
    expect(result.gatedRoots[0]).toMatchObject({ path: projectRoot, reason: "allowProjectSkills=false" });
  });

  it("preserves home-first ordering in the load set across multiple home roots", () => {
    const homeA = createRoot("home-a", "home-skill-a");
    const homeB = createRoot("home-b", "home-skill-b");
    const projectRoot = createRoot("project", "project-skill");

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeA, origin: "home" },
        { path: homeB, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ],
      flags: { allowProjectSkills: true }
    });

    expect(result.loadSet.map((r) => r.path)).toEqual([homeA, homeB, projectRoot]);
    expect(result.skillIds()).toEqual(["home-skill-a", "home-skill-b", "project-skill"]);
  });

  it("de-duplicates skill ids across admitted roots (first-wins) and keeps them sorted", () => {
    const homeRoot = createRoot("home", "shared-skill");
    const projectRoot = createRoot("project", "shared-skill");

    const result = discoverTrustedSkillRoots({
      roots: [
        { path: homeRoot, origin: "home" },
        { path: projectRoot, origin: "project", trusted: true }
      ],
      flags: { allowProjectSkills: true }
    });

    expect(result.skillIds()).toEqual(["shared-skill"]);
  });

  it("records a diagnostic when an admitted root cannot be enumerated", () => {
    const missingRoot = join(makeTempDirectory(), "does-not-exist");

    const result = discoverTrustedSkillRoots({
      roots: [{ path: missingRoot, origin: "home" }],
      flags: { allowProjectSkills: false }
    });

    // Home root is admitted by trust, but enumeration is non-fatal: loadSet keeps the root,
    // a diagnostic is recorded, and skillIds() is empty rather than throwing.
    expect(result.loadSet.map((r) => r.path)).toEqual([missingRoot]);
    expect(result.skillIds()).toEqual([]);
    expect(result.diagnostics.some((d) => d.includes(missingRoot))).toBe(true);
  });
});

function createTwoRoots(): { homeRoot: string; projectRoot: string } {
  return {
    homeRoot: createRoot("home", "home-skill"),
    projectRoot: createRoot("project", "project-skill")
  };
}

function createRoot(label: string, skillId: string): string {
  const root = makeTempDirectory();
  const skillDirectory = join(root, label, skillId);
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${skillId}`,
      `description: ${skillId} skill.`,
      "---",
      `# ${skillId}`,
      ""
    ].join("\n")
  );

  return root;
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-trust-gate-"));
  tempDirectories.push(directory);

  return directory;
}
