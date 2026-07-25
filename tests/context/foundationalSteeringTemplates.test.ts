import {
  generateProduct,
  generateStructure,
  generateTech
} from '../../src/context/foundationalSteeringTemplates.js';

describe("foundational steering templates", () => {
  it("includes the project name in each template", () => {
    const input = {
      projectName: "GuruHarness",
      stackHints: ["TypeScript", "Vitest"],
      topLevelDirectories: ["src", "tests"]
    };

    expect(generateProduct(input)).toContain("GuruHarness");
    expect(generateTech(input)).toContain("GuruHarness");
    expect(generateStructure(input)).toContain("GuruHarness");
  });

  it("lists detected top-level directories in the structure template", () => {
    const output = generateStructure({
      projectName: "Workspace Atlas",
      topLevelDirectories: ["src", "tests", "docs"]
    });

    expect(output).toContain("- `src` — describe what this area owns.");
    expect(output).toContain("- `tests` — describe what this area owns.");
    expect(output).toContain("- `docs` — describe what this area owns.");
  });

  it("handles an empty stack hint list", () => {
    const output = generateTech({
      projectName: "Signal Forge",
      stackHints: []
    });

    expect(output).toContain("- No stack hints detected yet.");
  });

  it("trims blank values and falls back for missing names", () => {
    const output = generateStructure({
      projectName: "   ",
      topLevelDirectories: ["src", " ", "src", "docs"]
    });

    expect(output).toContain("Unnamed project");
    expect(output).toContain("- `src` — describe what this area owns.");
    expect(output).toContain("- `docs` — describe what this area owns.");
    expect(output).not.toContain("- `` — describe what this area owns.");
  });
});
