import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BUILTIN_MODES,
  HARD_LIMIT_TOOL_IDS,
  ModeDefinitionSchema,
  ProjectModesFileSchema,
  loadProjectModes,
  mergeProjectModes
} from '../../src/modes/loadProjectModes.js';

describe("project mode schemas", () => {
  it("accepts a named mode with the supported fields", () => {
    const mode = ModeDefinitionSchema.parse({
      name: "docs",
      description: "Documentation work",
      toolAllowlist: ["read", "write"],
      systemAddendum: "Keep the docs concise and current."
    });

    expect(mode).toEqual({
      name: "docs",
      description: "Documentation work",
      toolAllowlist: ["read", "write"],
      systemAddendum: "Keep the docs concise and current."
    });
  });

  it("accepts the object file shape and rejects unknown fields", () => {
    expect(ProjectModesFileSchema.parse({ modes: [{ name: "docs", toolAllowlist: ["read"] }] })).toEqual({
      modes: [{ name: "docs", toolAllowlist: ["read"] }]
    });
    expect(ProjectModesFileSchema.parse({ modes: [] })).toEqual({ modes: [] });
    expect(() => ProjectModesFileSchema.parse({ modes: [], extra: true })).toThrow();
  });

  it.each(HARD_LIMIT_TOOL_IDS)("rejects %s as a mode tool", (toolId) => {
    expect(() => ModeDefinitionSchema.parse({ name: "unsafe", toolAllowlist: ["read", toolId] })).toThrow(
      /hard-limit/i
    );
  });
});

describe("mergeProjectModes", () => {
  it("overrides a builtin by name and appends a project mode", () => {
    const modes = mergeProjectModes([
      {
        name: "code",
        description: "Project code posture",
        toolAllowlist: ["read", "write"],
        systemAddendum: "Follow this repository's conventions."
      },
      { name: "docs", toolAllowlist: ["read"] }
    ]);

    expect(modes.find((mode) => mode.name === "code")).toEqual({
      name: "code",
      description: "Project code posture",
      toolAllowlist: ["read", "write"],
      systemAddendum: "Follow this repository's conventions."
    });
    expect(modes.some((mode) => mode.name === "docs")).toBe(true);
    expect(modes.filter((mode) => mode.name === "code")).toHaveLength(1);
    expect(modes.filter((mode) => mode.name === "plan")).toHaveLength(1);
  });

  it("does not mutate the builtin catalog while merging", () => {
    const before = structuredClone(BUILTIN_MODES);
    mergeProjectModes([{ name: "code", toolAllowlist: ["read"] }]);
    expect(BUILTIN_MODES).toEqual(before);
  });
});

describe("loadProjectModes", () => {
  it("loads .guru/modes.json and merges it over builtins", () => {
    const directory = makeTempDirectory();
    const guruDirectory = join(directory, ".guru");
    const path = join(guruDirectory, "modes.json");
    mkdirSync(guruDirectory, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        modes: [
          {
            name: "docs",
            description: "Documentation",
            toolAllowlist: ["read"],
            systemAddendum: "Use the project's documentation rules."
          }
        ]
      })
    );

    const result = loadProjectModes({ cwd: directory });

    expect(result.status).toBe("loaded");
    expect(result.verdict).toBe("GREEN");
    expect(result.source).toBe("file");
    expect(result.path).toBe(path);
    expect(result.modes.some((mode) => mode.name === "docs")).toBe(true);
    expect(result.modes.some((mode) => mode.name === "code")).toBe(true);

    rmSync(directory, { recursive: true, force: true });
  });

  it("returns builtins without an error when the project file is missing", () => {
    const directory = makeTempDirectory();
    const result = loadProjectModes({ cwd: directory });

    expect(result.status).toBe("missing");
    expect(result.verdict).toBe("YELLOW");
    expect(result.modes).toEqual(BUILTIN_MODES);
    expect(result.diagnostics[0]).toContain("modes.json");

    rmSync(directory, { recursive: true, force: true });
  });

  it("returns a red diagnostic and builtins for invalid JSON or schema", () => {
    const directory = makeTempDirectory();
    const guruDirectory = join(directory, ".guru");
    const path = join(guruDirectory, "modes.json");
    mkdirSync(guruDirectory, { recursive: true });
    writeFileSync(path, JSON.stringify({ modes: [{ name: "unsafe", toolAllowlist: ["destructive"] }] }));

    const result = loadProjectModes({ cwd: directory });

    expect(result.status).toBe("invalid");
    expect(result.verdict).toBe("RED");
    expect(result.modes).toEqual(BUILTIN_MODES);
    expect(result.diagnostics.join("\n")).toMatch(/hard-limit|invalid/i);

    rmSync(directory, { recursive: true, force: true });
  });

  it("can load the config key without touching the filesystem", () => {
    const result = loadProjectModes({
      config: {
        modes: [{ name: "ci", toolAllowlist: ["read"], description: "CI inspection" }]
      }
    });

    expect(result.status).toBe("loaded");
    expect(result.source).toBe("config");
    expect(result.modes.find((mode) => mode.name === "ci")).toMatchObject({ description: "CI inspection" });
  });
});

function makeTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "guruharness-modes-"));
}
