import {
  PluginCapabilityPackageSchema,
  parsePluginCapabilityPackage
} from '../../src/extensions/pluginCapabilityPackage.js';

describe("plugin capability package", () => {
  it("parses a valid package", () => {
    const input = {
      id: "workspace-operator",
      agents: ["workspace-agent"],
      skills: ["workspace-navigation"],
      commands: ["workspace.status"]
    };

    expect(parsePluginCapabilityPackage(input)).toEqual(input);
    expect(PluginCapabilityPackageSchema.parse(input)).toEqual(input);
  });

  it("rejects a missing id", () => {
    expect(() => parsePluginCapabilityPackage({
      agents: [],
      skills: [],
      commands: []
    })).toThrow();
  });
});
