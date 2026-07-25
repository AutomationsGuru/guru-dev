import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scaffoldSkill } from '../../src/garage/skillCreatorScaffold.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("scaffoldSkill — skill-creator scaffold (IDEA-F199-SKILL-CREATE)", () => {
  it("writes a SKILL.md with frontmatter (name, description, allowed-tools) and a body template", () => {
    const dir = tmpDir("guru-scaffold-");
    const written = scaffoldSkill({ name: "reconcile", dir });

    expect(written.ok).toBe(true);
    const skillFile = join(dir, "reconcile", "SKILL.md");
    if (written.ok) {
      expect(written.path).toBe(skillFile);
    }

    const content = readFileSync(skillFile, "utf8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toMatch(/^name:\s*reconcile\s*$/m);
    expect(content).toMatch(/^description:\s*.+$/m);
    expect(content).toMatch(/^allowed-tools:\s*.+$/m);
    expect(content).toContain("# reconcile");
  });

  it("uses an injectable fs so the same call works on an in-memory adapter", () => {
    const memory = new Map<string, string>();
    const fakeFs = {
      mkdirSync(path: string): void {
        memory.set(path, "dir:");
      },
      writeFileSync(path: string, content: string): void {
        memory.set(path, content);
      },
      existsSync(path: string): boolean {
        return memory.has(path);
      }
    };

    const written = scaffoldSkill({
      name: "audit-ledger",
      dir: "/virtual/skills",
      fs: fakeFs as never
    });

    expect(written.ok).toBe(true);
    expect(memory.get("/virtual/skills/audit-ledger/SKILL.md") ?? "").toMatch(/^---\nname:\s*audit-ledger\s*$/m);
  });

  it("creates the target subdirectory when it does not exist", () => {
    const dir = tmpDir("guru-scaffold-mkdir-");
    const skillDir = join(dir, "new-skill");
    expect(existsSync(skillDir)).toBe(false);

    const written = scaffoldSkill({ name: "new-skill", dir });
    expect(written.ok).toBe(true);

    // Parent dir + skill dir should now exist with SKILL.md written.
    expect(existsSync(skillDir)).toBe(true);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
  });

  it("rejects an empty skill name", () => {
    const dir = tmpDir("guru-scaffold-empty-");
    const written = scaffoldSkill({ name: "", dir });
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.reason).toMatch(/name/i);
    }
  });

  it("rejects a whitespace-only skill name", () => {
    const dir = tmpDir("guru-scaffold-ws-");
    const written = scaffoldSkill({ name: "   ", dir });
    expect(written.ok).toBe(false);
  });

  it("rejects a name that contains path separators or traversal segments", () => {
    const dir = tmpDir("guru-scaffold-sep-");
    const written = scaffoldSkill({ name: "../escape", dir });
    expect(written.ok).toBe(false);
  });
});
