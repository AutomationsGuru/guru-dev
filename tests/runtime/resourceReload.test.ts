import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createResourceReloader, reloadResources } from '../../src/runtime/resourceReload.js';
import { ResourceReloadTargetSchema } from '../../src/runtime/resourceReloadTypes.js';
import { createExtensionHost } from '../../src/extensions/host.js';
import { KIT_TOKENS } from '../../src/tui/theme.js';

async function makeSkillDirectory(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(resolve(tmpdir(), "guruharness-reload-skills-"));
  return {
    directory,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

describe("resourceReload", () => {
  describe("skills", () => {
    it("reloads skills and reflects added skill inventory", async () => {
      const { directory, cleanup } = await makeSkillDirectory();
      const skillFile = resolve(directory, "SKILL.md");
      await writeFile(
        skillFile,
        "---\nname: first-skill\ndescription: First reloadable skill.\n---\n# First skill\nBody.\n",
        "utf8"
      );

      try {
        const reloader = createResourceReloader({ skillLoaderOptions: { directories: [directory], cwd: directory } });
        const first = await reloader.reload(["skills"]);

        expect(first.ok).toBe(true);
        expect(first.summaries).toHaveLength(1);
        expect(first.summaries[0]).toMatchObject({
          target: "skills",
          ok: true,
          count: 1
        });
        expect(first.summaries[0]?.message).toMatch(/1 skill/);

        const secondSkillDirectory = resolve(directory, "second");
        await mkdir(secondSkillDirectory);
        await writeFile(
          resolve(secondSkillDirectory, "SKILL.md"),
          "---\nname: second-skill\ndescription: Second reloadable skill.\n---\n# Second skill\nBody.\n",
          "utf8"
        );

        const second = await reloader.reload(["skills"]);

        expect(second.ok).toBe(true);
        expect(second.summaries[0]?.count).toBe(2);
        expect(second.summaries[0]?.message).toMatch(/2 skill/);
      } finally {
        await cleanup();
      }
    });

    it("is idempotent when skill files have not changed", async () => {
      const { directory, cleanup } = await makeSkillDirectory();
      await writeFile(
        resolve(directory, "SKILL.md"),
        "---\nname: stable-skill\ndescription: Stable reloadable skill.\n---\n# Stable skill\nBody.\n",
        "utf8"
      );

      try {
        const reloader = createResourceReloader({ skillLoaderOptions: { directories: [directory], cwd: directory } });
        const first = await reloader.reload(["skills"]);
        const second = await reloader.reload(["skills"]);

        expect(first.summaries[0]?.count).toBe(second.summaries[0]?.count);
        expect(first.summaries[0]?.ok).toBe(second.summaries[0]?.ok);
        expect(first.summaries[0]?.diagnostics).toEqual(second.summaries[0]?.diagnostics);
      } finally {
        await cleanup();
      }
    });

    it("fails closed when the skill directory is missing", async () => {
      const missingDirectory = resolve(tmpdir(), "guruharness-reload-missing-skills-" + Date.now().toString(36));
      const result = await reloadResources({ skillLoaderOptions: { directories: [missingDirectory], cwd: tmpdir() } }, [
        "skills"
      ]);

      expect(result.ok).toBe(false);
      expect(result.summaries[0]).toMatchObject({
        target: "skills",
        ok: false,
        count: 0
      });
      expect(result.summaries[0]?.diagnostics[0]).toMatch(/Skill directory not found/);
    });
  });

  describe("theme", () => {
    it("reloads theme and reports the kit defaults when no theme file exists", async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "guruharness-reload-theme-"));
      const missingTheme = resolve(directory, "missing-theme.json");

      const result = await reloadResources({ themeFilePath: missingTheme }, ["theme"]);

      expect(result.ok).toBe(true);
      expect(result.summaries[0]).toMatchObject({
        target: "theme",
        ok: true,
        count: Object.keys(KIT_TOKENS).length
      });
      expect(result.summaries[0]?.message).toMatch(/from defaults/);
    });

    it("reloads a custom theme file and reports its token count", async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "guruharness-reload-theme-"));
      const themeFile = resolve(directory, "theme.json");
      await writeFile(themeFile, JSON.stringify({ name: "custom", colors: { accent: "#ff0000" } }), "utf8");

      const result = await reloadResources({ themeFilePath: themeFile }, ["theme"]);

      expect(result.ok).toBe(true);
      expect(result.summaries[0]).toMatchObject({
        target: "theme",
        ok: true
      });
      expect(result.summaries[0]?.message).toMatch(/from file/);
      expect(result.summaries[0]?.count).toBe(Object.keys(KIT_TOKENS).length);
    });
  });

  describe("extensions", () => {
    it("reloads an empty extension host and reports zero counts", async () => {
      const host = createExtensionHost();
      const result = await reloadResources({ extensionHost: host }, ["extensions"]);

      expect(result.ok).toBe(true);
      expect(result.summaries[0]).toMatchObject({
        target: "extensions",
        ok: true,
        count: 0
      });
      expect(result.summaries[0]?.message).toMatch(/0 command/);
    });

    it("fails closed when no extension host is provided", async () => {
      const result = await reloadResources({}, ["extensions"]);

      expect(result.ok).toBe(false);
      expect(result.summaries[0]).toMatchObject({
        target: "extensions",
        ok: false,
        count: 0
      });
      expect(result.summaries[0]?.diagnostics[0]).toMatch(/No extension host/);
    });
  });

  describe("multiple targets", () => {
    it("reloads all targets and returns ok when every target succeeds", async () => {
      const host = createExtensionHost();
      const result = await reloadResources({
        skillLoaderOptions: { directories: [], cwd: tmpdir() },
        extensionHost: host
      });

      expect(result.ok).toBe(true);
      expect(result.summaries).toHaveLength(3);
      expect(result.summaries.map((s) => s.target)).toEqual(["skills", "theme", "extensions"]);
    });
  });

  describe("invalid target", () => {
    it("rejects an invalid target string at the schema boundary", () => {
      expect(ResourceReloadTargetSchema.safeParse("invalid-target").success).toBe(false);
    });
  });
});
