import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills } from '../../src/skills/loader.js';
import {
  SKILL_APPROVALS_RELATIVE_PATH,
  annotateCatalogWithProvenance,
  readSkillApprovals,
  recordSkillApproval,
  resolveSkillTrustTier,
  skillProvenanceForManifest,
  type ProvenanceAnnotatedManifest
} from '../../src/skills/skillProvenance.js';
import { evaluateSkillTrustGate } from '../../src/skills/skillTrustGate.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("resolveSkillTrustTier", () => {
  it("classifies a skill under the bundled root as builtin", () => {
    const root = makeTempDirectory();
    const bundled = join(root, "bundled");
    const skillDirectory = mkdirSkill(bundled, "core");

    const tier = resolveSkillTrustTier({
      skillDirectory,
      bundledRoot: bundled,
      homeRoot: join(root, "home"),
      projectRoot: join(root, "project")
    });

    expect(tier).toBe("builtin");
  });

  it("classifies a skill under the home root as home", () => {
    const root = makeTempDirectory();
    const home = join(root, "home");
    const skillDirectory = mkdirSkill(home, "garden");

    const tier = resolveSkillTrustTier({
      skillDirectory,
      bundledRoot: join(root, "bundled"),
      homeRoot: home,
      projectRoot: join(root, "project")
    });

    expect(tier).toBe("home");
  });

  it("classifies a skill under the project root as project", () => {
    const root = makeTempDirectory();
    const project = join(root, "project");
    const skillDirectory = mkdirSkill(project, "repo");

    const tier = resolveSkillTrustTier({
      skillDirectory,
      bundledRoot: join(root, "bundled"),
      homeRoot: join(root, "home"),
      projectRoot: project
    });

    expect(tier).toBe("project");
  });

  it("classifies a skill outside every trusted root as external", () => {
    const root = makeTempDirectory();
    const elsewhere = join(root, "elsewhere");
    const skillDirectory = mkdirSkill(elsewhere, "foreign");

    const tier = resolveSkillTrustTier({
      skillDirectory,
      bundledRoot: join(root, "bundled"),
      homeRoot: join(root, "home"),
      projectRoot: join(root, "project")
    });

    expect(tier).toBe("external");
  });

  it("prefers builtin over home when roots overlap (bundled lives inside home)", () => {
    const root = makeTempDirectory();
    const bundled = join(root, "home", "bundled");
    const skillDirectory = mkdirSkill(bundled, "nested");

    const tier = resolveSkillTrustTier({
      skillDirectory,
      bundledRoot: bundled,
      homeRoot: join(root, "home"),
      projectRoot: join(root, "project")
    });

    expect(tier).toBe("builtin");
  });
});

describe("annotateCatalogWithProvenance", () => {
  it("attaches source path, content hash, and trust tier to each discovered skill", () => {
    const root = makeTempDirectory();
    const home = join(root, "home");
    mkdirSkill(home, "alpha");
    writeSkill(join(home, "alpha"), "alpha", "# Alpha\n");

    const catalog = discoverSkills({ directories: [home] });
    const annotated = annotateCatalogWithProvenance(catalog, {
      bundledRoot: join(root, "bundled"),
      homeRoot: home,
      projectRoot: join(root, "project")
    });

    const skill = annotated.skills[0] as ProvenanceAnnotatedManifest;
    expect(skill.id).toBe("alpha");
    expect(skill.provenance.tier).toBe("home");
    expect(skill.provenance.skillFile).toBe(join(home, "alpha", "SKILL.md"));
    expect(skill.provenance.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(skill.provenance.approved).toBe(false);
  });

  it("honors the current hash when an external skill is approved (approved: true)", () => {
    const root = makeTempDirectory();
    const external = join(root, "external");
    mkdirSkill(external, "foreign");
    const skillDirectory = join(external, "foreign");
    writeSkill(skillDirectory, "foreign", "# Foreign\n");

    const catalog = discoverSkills({ directories: [external] });
    const classification = { bundledRoot: join(root, "bundled"), homeRoot: join(root, "home"), projectRoot: join(root, "project") };
    const first = annotateCatalogWithProvenance(catalog, classification);
    expect(first.skills[0]?.provenance.tier).toBe("external");
    expect(first.skills[0]?.provenance.approved).toBe(false);

    recordSkillApproval({
      approvalsRoot: root,
      skillId: "foreign",
      contentHash: first.skills[0]!.provenance.contentHash
    });

    const second = annotateCatalogWithProvenance(catalog, {
      ...classification,
      approvalsRoot: root
    });
    expect(second.skills[0]?.provenance.approved).toBe(true);
  });
});

describe("evaluateSkillTrustGate", () => {
  it("blocks an unapproved external skill from model invocation (fail-closed default)", () => {
    const root = makeTempDirectory();
    const external = join(root, "external");
    mkdirSkill(external, "foreign");
    writeSkill(join(external, "foreign"), "foreign", "# Foreign\n");

    const annotated = annotateWithExternal(root, external);
    const decision = evaluateSkillTrustGate(annotated.skills[0]!);

    expect(decision.allowed).toBe(false);
    expect(decision.tier).toBe("external");
    expect(decision.reason).toContain("foreign");
    expect(decision.reason.toLowerCase()).toContain("approv");
  });

  it("allows a home skill for model invocation without any approval", () => {
    const root = makeTempDirectory();
    const home = join(root, "home");
    mkdirSkill(home, "garden");
    writeSkill(join(home, "garden"), "garden", "# Garden\n");

    const catalog = discoverSkills({ directories: [home] });
    const annotated = annotateCatalogWithProvenance(catalog, {
      bundledRoot: join(root, "bundled"),
      homeRoot: home,
      projectRoot: join(root, "project")
    });
    const decision = evaluateSkillTrustGate(annotated.skills[0]!);

    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("home");
  });

  it("allows builtin and project skills for model invocation", () => {
    const root = makeTempDirectory();
    const bundled = join(root, "bundled");
    const project = join(root, "project");
    mkdirSkill(bundled, "core");
    mkdirSkill(project, "repo");
    writeSkill(join(bundled, "core"), "core", "# Core\n");
    writeSkill(join(project, "repo"), "repo", "# Repo\n");

    const catalog = discoverSkills({ directories: [bundled, project] });
    const annotated = annotateCatalogWithProvenance(catalog, {
      bundledRoot: bundled,
      homeRoot: join(root, "home"),
      projectRoot: project
    });

    for (const skill of annotated.skills) {
      const decision = evaluateSkillTrustGate(skill);
      expect(decision.allowed).toBe(true);
      expect(["builtin", "project"]).toContain(decision.tier);
    }
  });

  it("allows an external skill once the operator approves its current hash", () => {
    const root = makeTempDirectory();
    const external = join(root, "external");
    mkdirSkill(external, "foreign");
    writeSkill(join(external, "foreign"), "foreign", "# Foreign\n");

    const annotated = annotateWithExternal(root, external);
    const skill = annotated.skills[0]!;
    expect(evaluateSkillTrustGate(skill).allowed).toBe(false);

    recordSkillApproval({
      approvalsRoot: root,
      skillId: skill.id,
      contentHash: skill.provenance.contentHash
    });

    const reannotated = annotateWithExternal(root, external);
    const decision = evaluateSkillTrustGate(reannotated.skills[0]!);
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("external");
  });

  it("invalidates the approval when the skill content hash changes", () => {
    const root = makeTempDirectory();
    const external = join(root, "external");
    mkdirSkill(external, "foreign");
    const skillDirectory = join(external, "foreign");
    writeSkill(skillDirectory, "foreign", "# Foreign v1\n");

    const before = annotateWithExternal(root, external).skills[0]!;
    recordSkillApproval({
      approvalsRoot: root,
      skillId: before.id,
      contentHash: before.provenance.contentHash
    });
    expect(evaluateSkillTrustGate(annotateWithExternal(root, external).skills[0]!).allowed).toBe(true);

    // Mutate the skill AFTER approval — the recorded hash no longer matches.
    writeSkill(skillDirectory, "foreign", "# Foreign v2 — tampered\n");

    const after = annotateWithExternal(root, external).skills[0]!;
    expect(after.provenance.contentHash).not.toBe(before.provenance.contentHash);
    const decision = evaluateSkillTrustGate(after);
    expect(decision.allowed).toBe(false);
    expect(decision.tier).toBe("external");
  });
});

describe("readSkillApprovals", () => {
  it("returns an empty store when the approvals file does not exist", () => {
    const root = makeTempDirectory();

    const store = readSkillApprovals(root);

    expect(store).toEqual({});
  });

  it("ignores malformed approvals files (treats them as no approvals — fail closed)", () => {
    const root = makeTempDirectory();
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, SKILL_APPROVALS_RELATIVE_PATH), "{ not json", "utf8");

    const store = readSkillApprovals(root);

    expect(store).toEqual({});
  });

  it("round-trips recorded approvals through readSkillApprovals", () => {
    const root = makeTempDirectory();

    recordSkillApproval({ approvalsRoot: root, skillId: "foreign", contentHash: "sha256:" + "ab".repeat(32) });
    const store = readSkillApprovals(root);

    expect(store["foreign"]).toEqual({
      contentHash: "sha256:" + "ab".repeat(32),
      approvedAt: expect.any(String)
    });
    expect(() => new Date(store["foreign"]!.approvedAt).toISOString()).not.toThrow();

    const raw = JSON.parse(readFileSync(join(root, SKILL_APPROVALS_RELATIVE_PATH), "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });
});

function annotateWithExternal(root: string, external: string) {
  const catalog = discoverSkills({ directories: [external] });
  return annotateCatalogWithProvenance(catalog, {
    bundledRoot: join(root, "bundled"),
    homeRoot: join(root, "home"),
    projectRoot: join(root, "project"),
    approvalsRoot: root
  });
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guru-skill-provenance-"));
  tempDirectories.push(directory);
  return directory;
}

function mkdirSkill(root: string, name: string): string {
  const skillDirectory = join(root, name);
  mkdirSync(skillDirectory, { recursive: true });
  return skillDirectory;
}

function writeSkill(skillDirectory: string, name: string, body: string): void {
  writeFileSync(join(skillDirectory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\n${body}`, "utf8");
}
