import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { score } from '../../src/skills/staticQualityScore.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("static skill and plugin quality score", () => {
  it("scores a complete artifact at 100", () => {
    const artifactPath = createArtifactPath();

    expect(score({
      name: "typescript-dev",
      description: "Use this skill for TypeScript work.",
      path: artifactPath
    })).toEqual({
      score: 100,
      checks: {
        name: true,
        description: true,
        pathExists: true
      }
    });
  });

  it("deducts only the checks missing from an incomplete artifact", () => {
    const result = score({ name: "typescript-dev", path: "/missing/skill" });

    expect(result.score).toBe(34);
    expect(result.checks).toEqual({
      name: true,
      description: false,
      pathExists: false
    });
  });

  it("treats whitespace-only metadata and paths as missing", () => {
    expect(score({ name: "  ", description: "\n", path: " " })).toEqual({
      score: 0,
      checks: {
        name: false,
        description: false,
        pathExists: false
      }
    });
  });
});

function createArtifactPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-static-quality-"));
  tempDirectories.push(directory);
  const artifactPath = join(directory, "SKILL.md");
  writeFileSync(artifactPath, "# Skill\n");

  return artifactPath;
}
