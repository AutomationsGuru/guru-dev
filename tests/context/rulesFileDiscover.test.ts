import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RULES_FILE_NAMES,
  discoverRulesFiles,
  isSecretRulesFileName
} from '../../src/context/rulesFileDiscover.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("DEFAULT_RULES_FILE_NAMES", () => {
  it("lists AGENTS.md first in the default merge order", () => {
    expect(DEFAULT_RULES_FILE_NAMES[0]).toBe("AGENTS.md");
    expect(DEFAULT_RULES_FILE_NAMES).toContain("RULES.md");
    expect(DEFAULT_RULES_FILE_NAMES).toContain(".clinerules");
    expect(DEFAULT_RULES_FILE_NAMES).toContain("CLAUDE.md");
  });
});

describe("discoverRulesFiles", () => {
  it("returns only existing default-name files with AGENTS.md first when both AGENTS.md and RULES.md exist", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "RULES.md"), "rules body\n");
    writeFileSync(join(root, "AGENTS.md"), "agents body\n");
    writeFileSync(join(root, "README.md"), "not a rules file\n");

    const found = discoverRulesFiles(root);

    expect(found).toEqual([resolve(root, "AGENTS.md"), resolve(root, "RULES.md")]);
  });

  it("respects custom names order and skips missing names", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "CLAUDE.md"), "claude body\n");
    writeFileSync(join(root, "RULES.md"), "rules body\n");

    const found = discoverRulesFiles(root, {
      names: ["RULES.md", "MISSING.md", "CLAUDE.md", "AGENTS.md"]
    });

    expect(found).toEqual([resolve(root, "RULES.md"), resolve(root, "CLAUDE.md")]);
  });

  it("never returns .env even when listed in names and present on disk", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.local"), "SECRET=2\n");
    writeFileSync(join(root, "AGENTS.md"), "agents body\n");

    const found = discoverRulesFiles(root, {
      names: [".env", ".env.local", "AGENTS.md", "RULES.md"]
    });

    expect(found).toEqual([resolve(root, "AGENTS.md")]);
    expect(found.some((path) => path.includes(".env"))).toBe(false);
  });

  it("returns an empty array when cwd has no matching rule files", () => {
    const root = makeTempDirectory();
    writeFileSync(join(root, "README.md"), "not rules\n");

    expect(discoverRulesFiles(root)).toEqual([]);
  });

  it("uses injectable exists for tests without touching the real filesystem layout", () => {
    const existing = new Set([
      resolve("/virtual/proj", "AGENTS.md"),
      resolve("/virtual/proj", ".clinerules")
    ]);

    const found = discoverRulesFiles("/virtual/proj", {
      exists: (path) => existing.has(path)
    });

    expect(found).toEqual([
      resolve("/virtual/proj", "AGENTS.md"),
      resolve("/virtual/proj", ".clinerules")
    ]);
  });
});

describe("isSecretRulesFileName", () => {
  it("is true for .env and .env.local", () => {
    expect(isSecretRulesFileName(".env")).toBe(true);
    expect(isSecretRulesFileName(".env.local")).toBe(true);
    expect(isSecretRulesFileName(".env.production")).toBe(true);
  });

  it("is false for AGENTS.md and RULES.md", () => {
    expect(isSecretRulesFileName("AGENTS.md")).toBe(false);
    expect(isSecretRulesFileName("RULES.md")).toBe(false);
    expect(isSecretRulesFileName(".clinerules")).toBe(false);
    expect(isSecretRulesFileName("CLAUDE.md")).toBe(false);
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-rules-discover-"));
  tempDirectories.push(directory);

  return directory;
}
