import { describe, expect, it } from "vitest";

import {
  ComponentRecordSchema,
  doctor,
  dryRunUninstall,
  rebuildInstallState,
  recordComponent,
  repair,
  type ComponentRepairFS,
  type InstallState,
  unrecordComponent
} from '../../src/home/componentLoadoutRepair.js';

// ── In-memory filesystem for isolated tests ──────────────────────────────

function memFS(): { fs: ComponentRepairFS; state: Map<string, string | "dir"> } {
  const store = new Map<string, string | "dir">();
  const fs: ComponentRepairFS = {
    exists: (path) => store.has(path),
    isDirectory: (path) => store.get(path) === "dir",
    readDir: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        entries.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...entries];
    },
    readFile: (path) => {
      const value = store.get(path);
      if (value === undefined || value === "dir") throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile: (path, content) => {
      // Ensure parent directories exist.
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!store.has(dir)) store.set(dir, "dir");
      }
      store.set(path, content);
    },
    mkdir: (path) => {
      store.set(path, "dir");
    },
    unlink: (path) => {
      store.delete(path);
    },
    rmdir: (path) => {
      store.delete(path);
    }
  };
  return { fs, state: store };
}

function setupHome(fs: ComponentRepairFS, root: string): void {
  fs.mkdir(root);
}

function fakeInstallStatePath(root: string): string {
  return `${root}/install-state.json`;
}

function writeInstallStateJSON(
  fs: ComponentRepairFS,
  root: string,
  state: InstallState
): void {
  fs.writeFile(fakeInstallStatePath(root), JSON.stringify(state, null, 2) + "\n");
}

// ── Helper: create a minimal home with components ────────────────────

function seedHome(
  fs: ComponentRepairFS,
  root: string,
  components: Array<{ id: string; files: string[] }>
): InstallState {
  setupHome(fs, root);
  const state: InstallState = {
    version: 1,
    generatedAt: new Date().toISOString(),
    components: []
  };

  for (const comp of components) {
    for (const file of comp.files) {
      fs.writeFile(`${root}/${file}`, `content-of-${file}`);
    }
    state.components.push({
      id: comp.id,
      installedAt: new Date().toISOString(),
      paths: comp.files
    });
  }

  writeInstallStateJSON(fs, root, state);
  return state;
}

// ── Schema validation ────────────────────────────────────────────────────

describe("ComponentRecord schema", () => {
  it("parses a valid record", () => {
    const parsed = ComponentRecordSchema.parse({
      id: "skills",
      installedAt: "2026-01-01T00:00:00.000Z",
      paths: ["skills/my-skill.md"]
    });
    expect(parsed.id).toBe("skills");
    expect(parsed.paths).toEqual(["skills/my-skill.md"]);
  });

  it("defaults paths to an empty array", () => {
    const parsed = ComponentRecordSchema.parse({
      id: "empty-component",
      installedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(parsed.paths).toEqual([]);
  });
});

// ── Doctor ────────────────────────────────────────────────────────────────

describe("doctor", () => {
  it("reports healthy when install-state and filesystem match", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-healthy";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/alpha.md", "skills/beta.md"] },
      { id: "tools", files: ["tools/grep.ts"] }
    ]);

    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(true);
    expect(report.recorded).toBe(2);
    expect(report.present).toEqual(["skills", "tools"]);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
  });

  it("flags missing component ids when paths do not exist on disk", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-missing";
    // Record three components but only create files for one.
    setupHome(fs, root);
    fs.writeFile(`${root}/skills/present.md`, "here");
    writeInstallStateJSON(fs, root, {
      version: 1,
      generatedAt: new Date().toISOString(),
      components: [
        { id: "skills", installedAt: new Date().toISOString(), paths: ["skills/present.md"] },
        { id: "garage", installedAt: new Date().toISOString(), paths: ["garage/manifest.json"] },
        { id: "tools", installedAt: new Date().toISOString(), paths: ["tools/missing-tool.ts"] }
      ]
    });

    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(false);
    expect(report.recorded).toBe(3);
    expect(report.present).toEqual(["skills"]);
    expect(report.missing).toEqual(["garage", "tools"]);
  });

  it("flags extra files not claimed by any component", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-extra";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/known.md"] }
    ]);
    // Add an extra file not in any component record.
    fs.writeFile(`${root}/stray-file.txt`, "orphan");

    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(false);
    expect(report.present).toEqual(["skills"]);
    expect(report.missing).toEqual([]);
    expect(report.extra).toContain("stray-file.txt");
  });

  it("reports healthy when install-state file is absent (nothing recorded, nothing extra)", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-empty";
    setupHome(fs, root);

    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(true);
    expect(report.recorded).toBe(0);
    expect(report.present).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
  });

  it("reports extra files when install-state is absent but files exist", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-orphan-files";
    setupHome(fs, root);
    fs.writeFile(`${root}/orphan.txt`, "alone");

    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(false);
    expect(report.recorded).toBe(0);
    expect(report.extra).toEqual(["orphan.txt"]);
  });

  it("skips the install-state file itself from extra reporting", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-self";
    setupHome(fs, root);
    // Write install-state with one component, but don't create the component files.
    writeInstallStateJSON(fs, root, {
      version: 1,
      generatedAt: new Date().toISOString(),
      components: [
        { id: "skills", installedAt: new Date().toISOString(), paths: ["skills/known.md"] }
      ]
    });
    fs.writeFile(`${root}/skills/known.md`, "here");

    const report = doctor({ homeDirectory: root, fs });
    // install-state.json itself must not appear in extra.
    expect(report.extra).not.toContain("install-state.json");
    expect(report.healthy).toBe(true);
  });
});

// ── Repair ───────────────────────────────────────────────────────────────

describe("repair", () => {
  it("removes extra files not claimed by any recorded component", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-repair-extra";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/good.md"] }
    ]);
    fs.writeFile(`${root}/stray.txt`, "should-be-removed");
    fs.writeFile(`${root}/nested/stray.log`, "also-extra");

    const report = repair({ homeDirectory: root, fs });
    expect(report.removed).toContain("stray.txt");
    expect(report.removed).toContain("nested/stray.log");
    expect(report.stillMissing).toEqual([]);
    expect(fs.exists(`${root}/stray.txt`)).toBe(false);
    expect(fs.exists(`${root}/nested/stray.log`)).toBe(false);
    // Recorded files survive.
    expect(fs.exists(`${root}/skills/good.md`)).toBe(true);
  });

  it("dry-run reports what would be removed without mutating", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-dryrun";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/keep.md"] }
    ]);
    fs.writeFile(`${root}/stray.txt`, "extra");

    const report = repair({ homeDirectory: root, fs, dryRun: true });
    expect(report.removed).toContain("stray.txt");
    expect(report.dryRun).toBe(true);
    // File still exists after dry-run.
    expect(fs.exists(`${root}/stray.txt`)).toBe(true);
    expect(fs.exists(`${root}/skills/keep.md`)).toBe(true);
  });

  it("records still-missing component ids that cannot be restored", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-cant-restore";
    setupHome(fs, root);
    // Record a component whose files were never created.
    writeInstallStateJSON(fs, root, {
      version: 1,
      generatedAt: new Date().toISOString(),
      components: [
        { id: "lost-tools", installedAt: new Date().toISOString(), paths: ["tools/lost.ts"] }
      ]
    });

    const report = repair({ homeDirectory: root, fs });
    expect(report.stillMissing).toEqual(["lost-tools"]);
    expect(report.removed).toEqual([]);
  });

  it("repair with no stray files and no missing components is a no-op success", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-clean";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/a.md"] }
    ]);

    const report = repair({ homeDirectory: root, fs });
    expect(report.stillMissing).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(fs.exists(`${root}/skills/a.md`)).toBe(true);
  });

  it("cleans empty directories left after removing extra files", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-empty-dirs";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/good.md"] }
    ]);
    // Create a stray file in a nested directory.
    fs.writeFile(`${root}/deep/nested/stray.txt`, "extra");

    repair({ homeDirectory: root, fs });
    // The stray file is gone.
    expect(fs.exists(`${root}/deep/nested/stray.txt`)).toBe(false);
    // The now-empty directories should be cleaned up.
    expect(fs.exists(`${root}/deep/nested`)).toBe(false);
    expect(fs.exists(`${root}/deep`)).toBe(false);
    // Recorded files survive.
    expect(fs.exists(`${root}/skills/good.md`)).toBe(true);
  });
});

// ── recordComponent ──────────────────────────────────────────────────────

describe("recordComponent", () => {
  it("writes an install-state record that doctor can later read", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-record";
    setupHome(fs, root);
    fs.writeFile(`${root}/skills/foo.md`, "skill content");

    recordComponent("skills", ["skills/foo.md"], { homeDirectory: root, fs });

    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(true);
    expect(report.recorded).toBe(1);
    expect(report.present).toEqual(["skills"]);
  });

  it("replaces an existing component entry with the same id", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-replace";
    setupHome(fs, root);
    fs.writeFile(`${root}/skills/old.md`, "old");
    fs.writeFile(`${root}/skills/new.md`, "new");

    recordComponent("skills", ["skills/old.md"], { homeDirectory: root, fs });
    recordComponent("skills", ["skills/new.md"], { homeDirectory: root, fs });

    const report = doctor({ homeDirectory: root, fs });
    // skills/old.md is now extra because the record only claims new.md.
    expect(report.extra).toContain("skills/old.md");
    expect(report.present).toEqual(["skills"]);
  });
});

// ── unrecordComponent ────────────────────────────────────────────────────

describe("unrecordComponent", () => {
  it("removes a component id from the install-state (files untouched)", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-unrecord";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/keep.md"] },
      { id: "tools", files: ["tools/drop.ts"] }
    ]);

    const result = unrecordComponent("tools", { homeDirectory: root, fs });
    expect(result).toBeDefined();
    expect(result!.components.map((c) => c.id)).toEqual(["skills"]);

    // Files are still on disk; doctor now reports them as extra.
    const report = doctor({ homeDirectory: root, fs });
    expect(report.extra).toContain("tools/drop.ts");
  });

  it("returns undefined when the id is not recorded", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-unrecord-missing";
    seedHome(fs, root, [{ id: "skills", files: ["skills/one.md"] }]);

    const result = unrecordComponent("nobody", { homeDirectory: root, fs });
    expect(result).toBeUndefined();
  });
});

// ── dryRunUninstall ──────────────────────────────────────────────────────

describe("dryRunUninstall", () => {
  it("lists every path that would be removed for the given component ids", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-uninstall-list";
    seedHome(fs, root, [
      { id: "skills", files: ["skills/a.md", "skills/b.md"] },
      { id: "tools", files: ["tools/x.ts"] },
      { id: "garage", files: ["garage/manifest.json"] }
    ]);

    const list = dryRunUninstall(["skills", "garage"], { homeDirectory: root, fs });
    expect(list.ids).toEqual(["garage", "skills"]);
    expect(list.paths).toEqual(["garage/manifest.json", "skills/a.md", "skills/b.md"]);
    expect(list.pathCount).toBe(3);
    // No mutation.
    expect(fs.exists(`${root}/skills/a.md`)).toBe(true);
    expect(fs.exists(`${root}/garage/manifest.json`)).toBe(true);
  });

  it("filters out paths that are already missing from disk", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-uninstall-partial";
    setupHome(fs, root);
    writeInstallStateJSON(fs, root, {
      version: 1,
      generatedAt: new Date().toISOString(),
      components: [
        { id: "skills", installedAt: new Date().toISOString(), paths: ["skills/missing.md", "skills/present.md"] }
      ]
    });
    fs.writeFile(`${root}/skills/present.md`, "here");

    const list = dryRunUninstall(["skills"], { homeDirectory: root, fs });
    expect(list.paths).toEqual(["skills/present.md"]);
    expect(list.pathCount).toBe(1);
  });

  it("returns empty results when no ids match", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-uninstall-none";
    seedHome(fs, root, [{ id: "skills", files: ["skills/a.md"] }]);

    const list = dryRunUninstall(["nobody"], { homeDirectory: root, fs });
    expect(list.ids).toEqual([]);
    expect(list.paths).toEqual([]);
    expect(list.pathCount).toBe(0);
  });
});

// ── rebuildInstallState ──────────────────────────────────────────────────

describe("rebuildInstallState", () => {
  it("reconstructs an install-state from the current filesystem", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-rebuild";
    setupHome(fs, root);
    fs.writeFile(`${root}/skills/alpha.md`, "skills");
    fs.writeFile(`${root}/tools/grep.ts`, "tool");
    // No install-state file exists yet.

    const state = rebuildInstallState({ homeDirectory: root, fs });
    expect(state.components.length).toBe(2);
    const ids = state.components.map((c) => c.id).sort();
    expect(ids).toEqual(["skills", "tools"]);

    // After rebuild, doctor is healthy.
    const report = doctor({ homeDirectory: root, fs });
    expect(report.healthy).toBe(true);
  });

  it("skips the install-state file so it does not become its own component", () => {
    const { fs } = memFS();
    const root = "/tmp/guru-home-rebuild-self";
    setupHome(fs, root);
    // Write a preexisting install-state so rebuild sees it on disk.
    writeInstallStateJSON(fs, root, { version: 1, generatedAt: "x", components: [] });
    fs.writeFile(`${root}/skills/x.md`, "skill");

    const state = rebuildInstallState({ homeDirectory: root, fs });
    expect(state.components.map((c) => c.id)).not.toContain("install-state.json");
    expect(state.components.map((c) => c.id)).toContain("skills");
  });
});
