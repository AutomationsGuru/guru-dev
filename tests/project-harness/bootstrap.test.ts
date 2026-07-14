import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureGuruHome, getGuruHomePaths } from "../../src/home/paths.js";
import { bootstrapProjectHarness, refreshProjectHarnessManifest } from "../../src/project-harness/bootstrap.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";

describe("project harness bootstrap", () => {
  it("creates project-owned state, mounts reusable home assets, and preserves a writable config", () => {
    const root = mkdtempSync(join(tmpdir(), "guruharness-project-harness-"));
    const homeDirectory = join(root, "home");
    const projectRoot = join(root, "project");

    try {
      const home = ensureGuruHome({ homeDirectory }).paths;
      writeFileSync(join(home.skillsDirectory, "shared-skill.md"), "shared v1", "utf8");
      writeFileSync(join(home.garageDirectory, "garage-note.md"), "garage v1", "utf8");
      writeFileSync(join(home.toolsDirectory, "tool-note.md"), "tool v1", "utf8");

      const report = bootstrapProjectHarness({ projectRoot, homeDirectory });

      expect(report.status).toBe("ready");
      expect(existsSync(report.manifestPath)).toBe(true);
      expect(existsSync(join(report.directory, "memory", "MEMORY.md"))).toBe(true);
      expect(report.assetLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "skills", status: "linked" }),
          expect.objectContaining({ kind: "garage", status: "linked" }),
          expect.objectContaining({ kind: "tools", status: "linked" })
        ])
      );
      expect(resolve(realpathSync(join(report.directory, "skills", "global")))).toBe(resolve(home.skillsDirectory));
      expect(readFileSync(join(report.directory, "skills", "global", "shared-skill.md"), "utf8")).toBe("shared v1");

      writeFileSync(join(home.skillsDirectory, "shared-skill.md"), "shared v2", "utf8");
      expect(readFileSync(join(report.directory, "skills", "global", "shared-skill.md"), "utf8")).toBe("shared v2");

      const config = HarnessConfigSchema.parse(JSON.parse(readFileSync(report.configPath, "utf8")));
      expect(config.skillDirectories).toEqual(["./skills/local", "./skills/global"]);
      writeFileSync(report.configPath, JSON.stringify({ runtimeName: "Project-specific Guru" }), "utf8");

      const second = bootstrapProjectHarness({ projectRoot, homeDirectory });
      expect(second.manifest?.configuration.status).toBe("existing");
      expect(JSON.parse(readFileSync(report.configPath, "utf8"))).toEqual({ runtimeName: "Project-specific Guru" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the tools and skills actually assembled for this project", () => {
    const root = mkdtempSync(join(tmpdir(), "guruharness-project-manifest-"));
    const homeDirectory = join(root, "home");
    const projectRoot = join(root, "project");

    try {
      ensureGuruHome({ homeDirectory });
      const bootstrapped = bootstrapProjectHarness({ projectRoot, homeDirectory });
      const refreshed = refreshProjectHarnessManifest({
        report: bootstrapped,
        toolIds: ["write", "read", "read"],
        skillIds: ["project-skill", "home-skill", "project-skill"]
      });

      expect(refreshed.manifest?.toolIds).toEqual(["read", "write"]);
      expect(refreshed.manifest?.skillIds).toEqual(["home-skill", "project-skill"]);
      expect(JSON.parse(readFileSync(refreshed.manifestPath, "utf8"))).toMatchObject({
        toolIds: ["read", "write"],
        skillIds: ["home-skill", "project-skill"]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
