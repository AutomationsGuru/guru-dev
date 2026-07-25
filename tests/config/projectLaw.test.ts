import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectLaw, PROJECT_LAW_FILE_NAME, ProjectLawSchema } from '../../src/config/projectLaw.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "guru-law-"));
  tempDirs.push(dir);
  return dir;
}

function writeLaw(root: string, segments: readonly string[], contents: unknown): string {
  const path = join(root, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("ProjectLawSchema", () => {
  it("parses a valid holds file with ask and block actions", () => {
    const law = ProjectLawSchema.parse({
      holds: [
        { text: "Confirm core edits", paths: ["src/core/**"], action: "ask" },
        { text: "Never write secrets", paths: [".env", "**/*.pem"], action: "block" }
      ]
    });
    expect(law.holds).toHaveLength(2);
    expect(law.holds[0]).toMatchObject({ action: "ask", paths: ["src/core/**"] });
    expect(law.holds[1]).toMatchObject({ action: "block" });
  });

  it("defaults holds to empty when omitted", () => {
    expect(ProjectLawSchema.parse({}).holds).toEqual([]);
  });

  it("rejects an unknown action, empty paths, empty text, and unknown keys (strict)", () => {
    expect(() => ProjectLawSchema.parse({ holds: [{ text: "x", paths: ["a"], action: "allow" }] })).toThrow();
    expect(() => ProjectLawSchema.parse({ holds: [{ text: "x", paths: [], action: "ask" }] })).toThrow();
    expect(() => ProjectLawSchema.parse({ holds: [{ text: "  ", paths: ["a"], action: "ask" }] })).toThrow();
    expect(() => ProjectLawSchema.parse({ holds: [{ text: "x", paths: ["a"], action: "ask", extra: 1 }] })).toThrow();
  });

  it("has no allow/grant action — a law file can never grant authority", () => {
    // Structural guarantee: the action enum is exactly ask|block, nothing permissive.
    for (const permissive of ["allow", "grant", "permit", "approve", "auto", "yolo"]) {
      expect(() => ProjectLawSchema.parse({ holds: [{ text: "x", paths: ["a"], action: permissive }] })).toThrow();
    }
  });
});

describe("loadProjectLaw", () => {
  it("returns no holds when neither project nor home law exists (fail open)", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toEqual([]);
    expect(result.sources.every((s) => s.status === "missing")).toBe(true);
  });

  it("loads a valid project .guru/law.json", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeLaw(cwd, [".guru", PROJECT_LAW_FILE_NAME], {
      holds: [{ text: "Confirm core edits", paths: ["src/core/**"], action: "ask" }]
    });
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toHaveLength(1);
    expect(result.holds[0]).toMatchObject({ text: "Confirm core edits", action: "ask" });
    const project = result.sources.find((s) => s.origin === "project");
    expect(project?.status).toBe("loaded");
  });

  it("merges project and home law files", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeLaw(cwd, [".guru", PROJECT_LAW_FILE_NAME], { holds: [{ text: "project hold", paths: ["a/**"], action: "ask" }] });
    writeLaw(home, [PROJECT_LAW_FILE_NAME], { holds: [{ text: "home hold", paths: ["b/**"], action: "block" }] });
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toHaveLength(2);
    expect(result.holds.map((h) => h.text).sort()).toEqual(["home hold", "project hold"]);
  });

  it("an invalid law file contributes NO holds and is reported (fail open)", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeLaw(cwd, [".guru", PROJECT_LAW_FILE_NAME], "{ not json !!!");
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toEqual([]);
    const project = result.sources.find((s) => s.origin === "project");
    expect(project?.status).toBe("invalid");
    expect(project?.diagnostics.length).toBeGreaterThan(0);
  });

  it("a schema-invalid law file (bad action) is invalid and yields no holds", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeLaw(cwd, [".guru", PROJECT_LAW_FILE_NAME], { holds: [{ text: "x", paths: ["a"], action: "allow" }] });
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toEqual([]);
    expect(result.sources.find((s) => s.origin === "project")?.status).toBe("invalid");
  });

  it("one invalid file does not mask a valid one", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeLaw(cwd, [".guru", PROJECT_LAW_FILE_NAME], "{ broken");
    writeLaw(home, [PROJECT_LAW_FILE_NAME], { holds: [{ text: "home hold", paths: ["b/**"], action: "block" }] });
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toHaveLength(1);
    expect(result.holds[0]?.text).toBe("home hold");
  });

  it("tolerates a UTF-8 BOM (Windows Notepad default)", () => {
    const cwd = makeTempDir();
    const home = makeTempDir();
    writeLaw(cwd, [".guru", PROJECT_LAW_FILE_NAME], `﻿${JSON.stringify({ holds: [{ text: "bom", paths: ["x/**"], action: "ask" }] })}`);
    const result = loadProjectLaw({ cwd, homeDirectory: home });
    expect(result.holds).toHaveLength(1);
    expect(result.sources.find((s) => s.origin === "project")?.status).toBe("loaded");
  });
});
