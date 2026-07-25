import { describe, expect, it } from "vitest";

import { clamp } from '../../src/swarm/subagentAutonomyClamp.js';

describe("subagent autonomy clamp", () => {
  it("inherits the parent level when the child has no preference", () => {
    expect(clamp({ level: "medium", spec: false }, undefined, "high")).toBe("medium");
  });

  it("clamps a child preference to its parent level", () => {
    expect(clamp({ level: "low", spec: false }, "high", "high")).toBe("low");
  });

  it("clamps a permitted child preference to the organization maximum", () => {
    expect(clamp({ level: "high", spec: false }, "high", "medium")).toBe("medium");
  });

  it("forces autonomy off for a specification-mode parent", () => {
    expect(clamp({ level: "high", spec: true }, "high", "high")).toBe("off");
  });
});
