import { describe, expect, it } from "vitest";

import {
  parseManifest,
  satisfies,
  PluginBundleManifestError,
  type PluginBundleManifest
} from '../../src/extensions/pluginBundleManifest.js';

describe("parseManifest", () => {
  it("parses name, version, skills[], hooks[] from an object", () => {
    const manifest = parseManifest({
      name: "my-bundle",
      version: "1.2.3",
      skills: [{ id: "code-review" }, { id: "deploy" }],
      hooks: [{ id: "tool-result" }]
    });

    expect(manifest).toEqual<PluginBundleManifest>({
      name: "my-bundle",
      version: "1.2.3",
      skills: [{ id: "code-review" }, { id: "deploy" }],
      hooks: [{ id: "tool-result" }]
    });
  });

  it("accepts a scoped name and a prerelease/build version", () => {
    const manifest = parseManifest({
      name: "@scope/bundle",
      version: "0.4.1-beta.2+build.9",
      skills: [],
      hooks: []
    });

    expect(manifest.name).toBe("@scope/bundle");
    expect(manifest.version).toBe("0.4.1-beta.2+build.9");
  });

  it("defaults skills and hooks to empty when omitted are still required (object must list arrays)", () => {
    // skills/hooks are required arrays per the contract; omitting is an error.
    expect(() => parseManifest({ name: "x", version: "1.0.0" })).toThrow(PluginBundleManifestError);
  });

  it("accepts a raw JSON string", () => {
    const manifest = parseManifest(
      JSON.stringify({ name: "str-bundle", version: "2.0.0", skills: [], hooks: [] })
    );
    expect(manifest.name).toBe("str-bundle");
    expect(manifest.version).toBe("2.0.0");
  });

  it("throws PluginBundleManifestError on non-JSON string", () => {
    expect(() => parseManifest("{not json")).toThrow(PluginBundleManifestError);
  });

  it("throws when input is not an object", () => {
    expect(() => parseManifest(null)).toThrow(PluginBundleManifestError);
    expect(() => parseManifest([])).toThrow(PluginBundleManifestError);
    expect(() => parseManifest(42)).toThrow(PluginBundleManifestError);
  });

  it("throws on a bad name", () => {
    expect(() =>
      parseManifest({ name: "bad name!", version: "1.0.0", skills: [], hooks: [] })
    ).toThrow(PluginBundleManifestError);
  });

  it("throws when skills is not an array", () => {
    expect(() =>
      parseManifest({ name: "x", version: "1.0.0", skills: "nope", hooks: [] })
    ).toThrow(PluginBundleManifestError);
  });

  it("throws when a skill entry lacks a valid id", () => {
    expect(() =>
      parseManifest({ name: "x", version: "1.0.0", skills: [{ id: "" }], hooks: [] })
    ).toThrow(PluginBundleManifestError);
  });

  describe("version (the required failure case)", () => {
    const badVersions = [
      "1", // missing minor.patch
      "1.2", // missing patch
      "1.2.3.4", // too many components
      "01.2.3", // leading zero
      "1.2.3-", // empty prerelease
      "v1.2.3", // leading v
      "1.x.3", // wildcard
      "latest", // tag, not semver
      "",
      1.2 // number, not string
    ];

    for (const bad of badVersions) {
      it(`fails on bad version ${JSON.stringify(bad)}`, () => {
        expect(() =>
          parseManifest({ name: "x", version: bad, skills: [], hooks: [] })
        ).toThrow(PluginBundleManifestError);
      });
    }

    it("reports the bad version in the message", () => {
      try {
        parseManifest({ name: "x", version: "v1.2.3", skills: [], hooks: [] });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PluginBundleManifestError);
        expect(String((error as Error).message)).toContain("version");
      }
    });
  });
});

describe("satisfies (semver check)", () => {
  it("exact match", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });

  it("caret range stays within major", () => {
    expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfies("1.9.0", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("0.9.9", "^1.2.3")).toBe(false);
  });

  it("caret range narrows for 0.x", () => {
    expect(satisfies("0.2.5", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
  });

  it("caret range narrows for 0.0.x", () => {
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  it("tilde range locks major.minor", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
  });

  it("OR range via ||", () => {
    expect(satisfies("1.2.3", "^1.2.0 || ^2.0.0")).toBe(true);
    expect(satisfies("2.1.0", "^1.2.0 || ^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^1.2.0 || ^2.0.0")).toBe(false);
  });

  it("throws on a bad concrete version", () => {
    expect(() => satisfies("nope", "1.0.0")).toThrow(PluginBundleManifestError);
  });

  it("throws on a bad range", () => {
    expect(() => satisfies("1.0.0", "")).toThrow(PluginBundleManifestError);
    expect(() => satisfies("1.0.0", "garbage")).toThrow(PluginBundleManifestError);
  });

  it("prerelease ordering: 1.0.0-alpha < 1.0.0", () => {
    expect(satisfies("1.0.0", "1.0.0-alpha")).toBe(false);
    expect(satisfies("1.0.0-alpha", "1.0.0-alpha")).toBe(true);
  });
});

describe("manifest engines.guru range", () => {
  it("accepts a valid engines.guru range and does not bind it to the bundle version", () => {
    const manifest = parseManifest({
      name: "x",
      version: "1.0.0",
      skills: [],
      hooks: [],
      engines: { guru: "^1.5.0" }
    });
    expect(manifest.engines?.guru).toBe("^1.5.0");
  });

  it("rejects a malformed engines.guru range at parse time", () => {
    expect(() =>
      parseManifest({ name: "x", version: "1.0.0", skills: [], hooks: [], engines: { guru: "garbage" } })
    ).toThrow(PluginBundleManifestError);
  });
});
