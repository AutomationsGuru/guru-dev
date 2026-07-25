import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PLUGIN_BUNDLE_MANIFEST_VERSION, PluginBundleSchema, type PluginBundle } from '../../src/garage/pluginBundleSchema.js';
import { BUNDLE_CATEGORY_DIRS, applyInstall, planInstall, validateBundle } from '../../src/garage/pluginBundle.js';

let n = 0;
const dirs: string[] = [];
function freshOverlay(): string {
  const directory = join(tmpdir(), `guru-bundle-${process.pid}-${n++}`);
  dirs.push(directory);
  mkdirSync(directory, { recursive: true });
  return directory;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function validBundle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "code-review-pack",
    version: "1.2.3",
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_VERSION,
    description: "A review-focused bundle",
    skills: [
      { path: "review.md", content: "# Review skill\n" },
      { path: "security/audit.md", content: "# Audit\n" }
    ],
    hooks: [{ path: "pre-commit.json", content: "{}\n" }],
    commands: [{ path: "git/commit.json", content: "{}\n" }],
    specialists: [{ path: "reviewer.json", content: "{}\n" }],
    ...over
  };
}

describe("PluginBundleSchema + validateBundle", () => {
  it("rejects a manifest with a missing id", () => {
    const { id: _id, ...rest } = validBundle();
    const result = validateBundle(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("id"))).toBe(true);
    }
  });

  it("rejects an id with an unsafe charset", () => {
    for (const id of ["Bad Slug!", "UPPERCASE", "-leading-dash", "has/slash", "..", "a b"]) {
      const result = validateBundle(validBundle({ id }));
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an empty version", () => {
    const result = validateBundle(validBundle({ version: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    }
  });

  it("rejects a non-semver-ish version", () => {
    const result = validateBundle(validBundle({ version: "latest" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    const result = validateBundle(validBundle({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    }
  });

  it("rejects an absolute entry path", () => {
    const result = validateBundle(validBundle({ skills: [{ path: "/etc/passwd", content: "x" }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("skills.0.path"))).toBe(true);
    }
  });

  it("rejects a Windows-style absolute entry path", () => {
    const result = validateBundle(validBundle({ skills: [{ path: "C:\\evil\\file.md", content: "x" }] }));
    expect(result.ok).toBe(false);
  });

  it("rejects a backslash path entirely (no drive shenanigans)", () => {
    const result = validateBundle(validBundle({ skills: [{ path: "a\\b.md", content: "x" }] }));
    expect(result.ok).toBe(false);
  });

  it("rejects a .. traversal entry path", () => {
    for (const p of ["../evil.md", "a/../../evil.md", ".."]) {
      const result = validateBundle(validBundle({ hooks: [{ path: p, content: "x" }] }));
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an empty entry path and an empty entry content guard target", () => {
    const result = validateBundle(validBundle({ skills: [{ path: "", content: "x" }] }));
    expect(result.ok).toBe(false);
  });

  it("rejects unknown extra keys (strict object)", () => {
    const result = validateBundle(validBundle({ marketplace: "https://evil.example" }));
    expect(result.ok).toBe(false);
  });

  it("parses a valid bundle and validateBundle round-trips it", () => {
    const parsed = PluginBundleSchema.parse(validBundle());
    expect(parsed.id).toBe("code-review-pack");
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.skills).toHaveLength(2);
    const result = validateBundle(validBundle());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle).toEqual(parsed);
    }
  });

  it("never throws on garbage input", () => {
    for (const garbage of [null, undefined, 42, "nope", [], { id: 1 }]) {
      expect(() => validateBundle(garbage)).not.toThrow();
      expect(validateBundle(garbage).ok).toBe(false);
    }
  });
});

describe("planInstall", () => {
  it("fresh overlay: every entry is create, targets land under category subdirs, no conflicts", () => {
    const overlay = freshOverlay();
    const bundle = PluginBundleSchema.parse(validBundle());
    const plan = planInstall(bundle, overlay);
    expect(plan.conflicts).toEqual([]);
    expect(plan.entries.every((e) => e.status === "create")).toBe(true);
    expect(plan.overlayRoot).toBe(overlay);
    const byCategory = (cat: keyof typeof BUNDLE_CATEGORY_DIRS) =>
      plan.entries.filter((e) => e.category === cat).map((e) => e.targetPath);
    expect(byCategory("skills")).toEqual([join(overlay, "skills", "review.md"), join(overlay, "skills", "security", "audit.md")]);
    expect(byCategory("hooks")).toEqual([join(overlay, "hooks", "pre-commit.json")]);
    expect(byCategory("commands")).toEqual([join(overlay, "commands", "git", "commit.json")]);
    expect(byCategory("specialists")).toEqual([join(overlay, "specialists", "reviewer.json")]);
    // entries sorted deterministically: category order, then path
    expect(plan.entries.map((e) => `${e.category}:${e.sourcePath}`)).toEqual([
      "skills:review.md",
      "skills:security/audit.md",
      "hooks:pre-commit.json",
      "commands:git/commit.json",
      "specialists:reviewer.json"
    ]);
  });

  it("marks a pre-existing target as conflict", () => {
    const overlay = freshOverlay();
    const existing = join(overlay, "skills", "review.md");
    mkdirSync(join(overlay, "skills"), { recursive: true });
    writeFileSync(existing, "ORIGINAL\n", "utf8");
    const bundle = PluginBundleSchema.parse(validBundle());
    const plan = planInstall(bundle, overlay);
    expect(plan.conflicts).toEqual([existing]);
    expect(plan.entries.find((e) => e.targetPath === existing)?.status).toBe("conflict");
    expect(plan.entries.filter((e) => e.status === "create")).toHaveLength(4);
  });
});

describe("applyInstall", () => {
  it("happy path: writes every file with exact content and reports installed", () => {
    const overlay = freshOverlay();
    const bundle = PluginBundleSchema.parse(validBundle());
    const result = applyInstall(bundle, overlay);
    expect(result.status).toBe("installed");
    if (result.status === "installed") {
      expect(result.written).toHaveLength(5);
      expect(result.overwritten).toEqual([]);
    }
    expect(readFileSync(join(overlay, "skills", "review.md"), "utf8")).toBe("# Review skill\n");
    expect(readFileSync(join(overlay, "skills", "security", "audit.md"), "utf8")).toBe("# Audit\n");
    expect(readFileSync(join(overlay, "hooks", "pre-commit.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(overlay, "commands", "git", "commit.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(overlay, "specialists", "reviewer.json"), "utf8")).toBe("{}\n");
  });

  it("conflict without force: status conflict, error lists the path, nothing is written anywhere", () => {
    const overlay = freshOverlay();
    const existing = join(overlay, "skills", "review.md");
    mkdirSync(join(overlay, "skills"), { recursive: true });
    writeFileSync(existing, "ORIGINAL\n", "utf8");
    const bundle = PluginBundleSchema.parse(validBundle());
    const result = applyInstall(bundle, overlay);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.conflicts).toEqual([existing]);
      expect(result.error).toContain(existing);
    }
    // pre-existing file untouched
    expect(readFileSync(existing, "utf8")).toBe("ORIGINAL\n");
    // all-or-nothing: no other entry was written
    expect(existsSync(join(overlay, "skills", "security", "audit.md"))).toBe(false);
    expect(existsSync(join(overlay, "hooks", "pre-commit.json"))).toBe(false);
    expect(existsSync(join(overlay, "commands", "git", "commit.json"))).toBe(false);
    expect(existsSync(join(overlay, "specialists", "reviewer.json"))).toBe(false);
  });

  it("force: overwrites the conflict and reports it in overwritten", () => {
    const overlay = freshOverlay();
    const existing = join(overlay, "skills", "review.md");
    mkdirSync(join(overlay, "skills"), { recursive: true });
    writeFileSync(existing, "ORIGINAL\n", "utf8");
    const bundle = PluginBundleSchema.parse(validBundle());
    const result = applyInstall(bundle, overlay, { force: true });
    expect(result.status).toBe("installed");
    if (result.status === "installed") {
      expect(result.overwritten).toEqual([existing]);
      expect(result.written).toHaveLength(5);
    }
    expect(readFileSync(existing, "utf8")).toBe("# Review skill\n");
    expect(readFileSync(join(overlay, "specialists", "reviewer.json"), "utf8")).toBe("{}\n");
  });

  it("dryRun: status dry-run, nothing lands on disk", () => {
    const overlay = freshOverlay();
    const bundle = PluginBundleSchema.parse(validBundle());
    const result = applyInstall(bundle, overlay, { dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(existsSync(join(overlay, "skills"))).toBe(false);
    expect(existsSync(join(overlay, "hooks"))).toBe(false);
    expect(existsSync(join(overlay, "commands"))).toBe(false);
    expect(existsSync(join(overlay, "specialists"))).toBe(false);
  });

  it("dryRun with a conflict reports the conflict and writes nothing", () => {
    const overlay = freshOverlay();
    const existing = join(overlay, "skills", "review.md");
    mkdirSync(join(overlay, "skills"), { recursive: true });
    writeFileSync(existing, "ORIGINAL\n", "utf8");
    const bundle = PluginBundleSchema.parse(validBundle());
    const result = applyInstall(bundle, overlay, { dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(readFileSync(existing, "utf8")).toBe("ORIGINAL\n");
    expect(existsSync(join(overlay, "hooks"))).toBe(false);
  });

  it("dryRun + force together still writes nothing", () => {
    const overlay = freshOverlay();
    const existing = join(overlay, "skills", "review.md");
    mkdirSync(join(overlay, "skills"), { recursive: true });
    writeFileSync(existing, "ORIGINAL\n", "utf8");
    const bundle = PluginBundleSchema.parse(validBundle());
    const result = applyInstall(bundle, overlay, { dryRun: true, force: true });
    expect(result.status).toBe("dry-run");
    expect(readFileSync(existing, "utf8")).toBe("ORIGINAL\n");
  });
});
