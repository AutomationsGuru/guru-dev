import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGuruHome, getGuruHomePaths } from "../../src/home/paths.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";

describe("Guru home profile", () => {
  it("initializes reusable directories, a safe config, and an empty Markdown vault without overwriting config", () => {
    const root = mkdtempSync(join(tmpdir(), "guruharness-home-"));

    try {
      const first = ensureGuruHome({ homeDirectory: root });
      const paths = getGuruHomePaths(root);

      expect(first.configCreated).toBe(true);
      expect(paths.root).toBe(root);
      expect(existsSync(paths.skillsDirectory)).toBe(true);
      expect(existsSync(paths.garageDirectory)).toBe(true);
      expect(existsSync(paths.toolsDirectory)).toBe(true);
      expect(existsSync(paths.rolesDirectory)).toBe(true);
      expect(existsSync(paths.sessionsDirectory)).toBe(true);
      expect(existsSync(join(paths.memoryDirectory, "MEMORY.md"))).toBe(true);
      expect(HarnessConfigSchema.parse(JSON.parse(readFileSync(paths.configPath, "utf8"))).skillDirectories).toEqual(["./skills"]);

      writeFileSync(paths.configPath, JSON.stringify({ runtimeName: "My home default" }));
      const second = ensureGuruHome({ homeDirectory: root });

      expect(second.configCreated).toBe(false);
      expect(JSON.parse(readFileSync(paths.configPath, "utf8"))).toEqual({ runtimeName: "My home default" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
