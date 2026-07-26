import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFleetConfig } from "../../src/fleet/fleetConfig.js";

const directories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guru-fleet-config-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseFleetConfig", () => {
  it("loads a valid JSON fleet config", () => {
    const directory = makeTempDirectory();
    const configPath = join(directory, "fleet.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: {
          read: { description: "Read files" },
          bash: { description: "Run shell commands" }
        },
        roles: {
          planner: { tools: ["read"], modelSlot: "smart" }
        },
        modelSlots: {
          smart: { routeId: "router-claude-sonnet-4-6" }
        },
        agents: [{ name: "planner", role: "planner", tools: ["bash"], modelSlot: "smart" }]
      })
    );

    const config = parseFleetConfig(configPath);

    expect(Object.keys(config.tools)).toEqual(["read", "bash"]);
    expect(config.roles.planner).toMatchObject({ tools: ["read"], modelSlot: "smart" });
    expect(config.modelSlots.smart).toMatchObject({ routeId: "router-claude-sonnet-4-6" });
    expect(config.agents).toEqual([{ name: "planner", role: "planner", tools: ["bash"], modelSlot: "smart" }]);
  });

  it("loads a valid TOML fleet config", () => {
    const directory = makeTempDirectory();
    const configPath = join(directory, "fleet.toml");
    writeFileSync(
      configPath,
      [
        "[tools.read]",
        'description = "Read files"',
        "",
        "[tools.bash]",
        'description = "Run shell commands"',
        "",
        "[roles.reviewer]",
        'tools = ["read"]',
        'modelSlot = "fast"',
        "",
        "[modelSlots.fast]",
        'provider = "anthropic"',
        'model = "claude-haiku-4-5"',
        "",
        "[[agents]]",
        'name = "reviewer"',
        'role = "reviewer"',
        'tools = ["bash"]',
        'modelSlot = "fast"'
      ].join("\n")
    );

    const config = parseFleetConfig(configPath);

    expect(config.roles.reviewer?.tools).toEqual(["read"]);
    expect(config.modelSlots.fast).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(config.agents[0]).toEqual({ name: "reviewer", role: "reviewer", tools: ["bash"], modelSlot: "fast" });
  });

  it("fails closed when the fleet has no agents", () => {
    const directory = makeTempDirectory();
    const configPath = join(directory, "fleet.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        tools: { read: { description: "Read files" } },
        roles: { planner: { tools: ["read"] } },
        modelSlots: { smart: { routeId: "router-claude-sonnet-4-6" } }
      })
    );

    expect(() => parseFleetConfig(configPath)).toThrow(/at least one agent/i);
  });
});
