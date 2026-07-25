import { describe, expect, it } from "vitest";

import { runLayers } from '../../src/skills/pluginEvalStaticLayers.js';

describe("runLayers", () => {
  it("runs named checks and reports each passing result", () => {
    const result = runLayers([
      { name: "frontmatter", check: () => true },
      { name: "paths", check: () => true }
    ]);

    expect(result).toEqual({
      passed: true,
      results: [
        { name: "frontmatter", passed: true },
        { name: "paths", passed: true }
      ]
    });
  });

  it("fails the overall result when any check fails", () => {
    const result = runLayers([
      { name: "frontmatter", check: () => true },
      { name: "links", check: () => false },
      { name: "paths", check: () => true }
    ]);

    expect(result.passed).toBe(false);
    expect(result.results).toEqual([
      { name: "frontmatter", passed: true },
      { name: "links", passed: false },
      { name: "paths", passed: true }
    ]);
  });
});
