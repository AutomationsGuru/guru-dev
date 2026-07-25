import {
  INITIAL_AGENT_PROJECT_VERSION,
  createAgentProjectManifest,
  enhanceAgentProjectManifest,
  upgradeAgentProjectManifest
} from '../../src/home/agentProjectScaffold.js';

describe("agent project scaffold lifecycle", () => {
  it("creates a portable manifest with a normalized skill catalog", () => {
    expect(createAgentProjectManifest({ name: "  Release helper  ", skills: ["lint", " build ", "lint", ""] })).toEqual({
      name: "Release helper",
      version: INITIAL_AGENT_PROJECT_VERSION,
      skills: ["build", "lint"]
    });
  });

  it("enhances a manifest without replacing existing skills or changing its version", () => {
    const created = createAgentProjectManifest({ name: "Release helper", skills: ["build"] });
    const enhanced = enhanceAgentProjectManifest(created, { skills: ["lint", "build"] });

    expect(enhanced).toEqual({
      name: "Release helper",
      version: INITIAL_AGENT_PROJECT_VERSION,
      skills: ["build", "lint"]
    });
    expect(created).toEqual({
      name: "Release helper",
      version: INITIAL_AGENT_PROJECT_VERSION,
      skills: ["build"]
    });
  });

  it("upgrades by bumping only the manifest version", () => {
    const created = createAgentProjectManifest({ name: "Release helper", skills: ["build", "lint"] });
    const upgraded = upgradeAgentProjectManifest(created);

    expect(upgraded).toEqual({
      name: "Release helper",
      version: INITIAL_AGENT_PROJECT_VERSION + 1,
      skills: ["build", "lint"]
    });
    expect(created.version).toBe(INITIAL_AGENT_PROJECT_VERSION);
  });
});
