import { describe, expect, it } from "vitest";

import { createSharedCapabilityProfileStore } from '../../src/home/sharedCapabilityProfile.js';

describe("shared capability profiles", () => {
  it("binds multiple agents to one profile without changing its MCP or skill metadata", () => {
    const store = createSharedCapabilityProfileStore();
    const profile = store.create({
      id: "research-team",
      mcpServers: ["knowledge-base"],
      skills: ["research.notes"]
    });

    store.bind("agent-a", profile.id);
    store.bind("agent-b", profile.id);

    expect(store.resolve("agent-a")).toEqual(profile);
    expect(store.resolve("agent-b")).toEqual(profile);
    expect(store.resolve("agent-a")).toBe(store.resolve("agent-b"));
  });

  it("rejects bindings to unknown profiles and duplicate profile ids", () => {
    const store = createSharedCapabilityProfileStore();

    expect(() => store.bind("agent-a", "missing")).toThrow("Unknown shared capability profile: missing");

    store.create({ id: "research-team", mcpServers: [], skills: [] });
    expect(() => store.create({ id: "research-team", mcpServers: [], skills: [] })).toThrow("Duplicate shared capability profile id: research-team");
  });
});
