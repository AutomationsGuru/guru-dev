import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_CONFIG_BUNDLE_DIR,
  AGENT_CONFIG_BUNDLE_FILE_NAME,
  AGENT_CONFIG_BUNDLE_VERSION,
  DEFAULT_AGENT_CONFIG_BUNDLE,
  EmbeddedSecretError,
  exportAgentConfigBundle,
  findEmbeddedSecret,
  loadAgentConfigBundle,
  rejectEmbeddedSecrets,
  saveAgentConfigBundle
} from '../../src/config/agentConfigBundle.js';
import { AgentConfigBundleSchema } from '../../src/config/agentConfigBundleSchema.js';

describe("AgentConfigBundleSchema", () => {
  it("parses a minimal bundle with safe defaults", () => {
    const bundle = AgentConfigBundleSchema.parse({});
    expect(bundle.version).toBe(AGENT_CONFIG_BUNDLE_VERSION);
    expect(bundle.project).toBe("unspecified-project");
    expect(bundle.providers).toEqual([]);
    expect(bundle.models).toEqual([]);
    expect(bundle.rules).toEqual([]);
  });

  it("accepts a full valid bundle describing models, providers, and rules with env-name refs only", () => {
    const bundle = AgentConfigBundleSchema.parse({
      project: "acme-agent",
      providers: [
        { name: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnvVar: "OPENAI_API_KEY" },
        { name: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434", apiKeyEnvVar: "LOCAL_KEY" }
      ],
      models: [
        { role: "planner", provider: "openai", model: "gpt-5.6-sol", temperature: 0 },
        { role: "critic", provider: "local", model: "llama-3", apiKeyEnvVar: "CRITIC_KEY" }
      ],
      rules: [
        { name: "constitution", path: ".guru/rules/yolo.md", required: true },
        { name: "team", path: ".guru/rules/team.md", order: 5, required: false }
      ]
    });

    expect(bundle.models[0]).toMatchObject({ role: "planner", provider: "openai", model: "gpt-5.6-sol" });
    expect(bundle.rules[1]).toMatchObject({ order: 5, required: false });
  });

  it("rejects an apiKeyEnvVar that is not an UPPERCASE env-var NAME (a value sneaks in)", () => {
    expect(() =>
      AgentConfigBundleSchema.parse({
        providers: [{ name: "openai", kind: "openai-compatible", apiKeyEnvVar: "sk-abcd1234" }]
      })
    ).toThrow();
  });

  it("rejects a non-HTTPS remote baseUrl (only localhost is exempt)", () => {
    expect(() =>
      AgentConfigBundleSchema.parse({
        providers: [{ name: "insecure", kind: "openai-compatible", baseUrl: "http://remote.example.com" }]
      })
    ).toThrow();
    expect(() =>
      AgentConfigBundleSchema.parse({
        providers: [{ name: "ok", kind: "openai-compatible", baseUrl: "http://localhost:8080" }]
      })
    ).not.toThrow();
  });

  it("rejects a model role that references an undeclared provider", () => {
    const result = AgentConfigBundleSchema.safeParse({
      providers: [{ name: "openai", kind: "openai-compatible" }],
      models: [{ role: "planner", provider: "anthropic", model: "claude-3" }]
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict shape)", () => {
    expect(() => AgentConfigBundleSchema.parse({ surprise: true })).toThrow();
  });
});

describe("findEmbeddedSecret / rejectEmbeddedSecrets", () => {
  const SECRET_FIXTURES: Array<[string, string]> = [
    ["openai key", '"key": "sk-1234567890abcdefghij"'],
    ["aws key", '"arn": "AKIAIOSFODNN7EXAMPLE"'],
    ["slack token", '"token": "xoxb-1234567890-abcdefghij"'],
    ["github token", '"token": "ghp_1234567890abcdefghij"'],
    ["stripe key", '"key": "sk_live_1234567890abcdefghij"'],
    ["pem block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["jwt", '"jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"']
  ];

  it.each(SECRET_FIXTURES)("detects an embedded %s", (_label, fixture) => {
    expect(findEmbeddedSecret(fixture)).not.toBeNull();
    expect(rejectEmbeddedSecrets(fixture)).toBe(true);
  });

  it("does not flag ordinary env-var NAME references or prose", () => {
    const clean = JSON.stringify({
      providers: [{ name: "openai", kind: "openai-compatible", apiKeyEnvVar: "OPENAI_API_KEY", notes: "team planner key" }]
    });
    expect(findEmbeddedSecret(clean)).toBeNull();
    expect(rejectEmbeddedSecrets(clean)).toBe(false);
  });

  it("reports the kind and a 1-indexed line number, never the value", () => {
    const raw = ['{', '  "x": "sk-1234567890abcdefghij"', '}'].join("\n");
    const hit = findEmbeddedSecret(raw);
    expect(hit).not.toBeNull();
    expect(hit?.line).toBe(2);
    expect(hit?.kind).toMatch(/api key/i);
  });
});

describe("loadAgentConfigBundle", () => {
  it("loads a valid project bundle from <cwd>/.guru/agent-config.json", () => {
    const directory = makeTempDirectory();
    const bundleDir = join(directory, AGENT_CONFIG_BUNDLE_DIR);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, AGENT_CONFIG_BUNDLE_FILE_NAME),
      JSON.stringify({
        project: "loaded-project",
        providers: [{ name: "openai", kind: "openai-compatible", apiKeyEnvVar: "OPENAI_API_KEY" }],
        models: [{ role: "planner", provider: "openai", model: "gpt-5.6-sol" }]
      })
    );

    const result = loadAgentConfigBundle({ cwd: directory });

    expect(result.status).toBe("loaded");
    expect(result.verdict).toBe("GREEN");
    expect(result.source).toBe("project");
    expect(result.bundle.project).toBe("loaded-project");
    expect(result.bundle.models[0]?.role).toBe("planner");

    rmSync(directory, { recursive: true, force: true });
  });

  it("returns YELLOW with safe defaults when the bundle is missing (adoption is opt-in)", () => {
    const directory = makeTempDirectory();
    const result = loadAgentConfigBundle({ cwd: directory });

    expect(result.status).toBe("missing");
    expect(result.verdict).toBe("YELLOW");
    expect(result.source).toBe("defaults");
    expect(result.bundle).toEqual(DEFAULT_AGENT_CONFIG_BUNDLE);
    expect(result.diagnostics[0]).toContain("not found");

    rmSync(directory, { recursive: true, force: true });
  });

  it("does not hide a missing EXPLICIT path behind the project default", () => {
    const directory = makeTempDirectory();
    const projectBundleDir = join(directory, AGENT_CONFIG_BUNDLE_DIR);
    mkdirSync(projectBundleDir, { recursive: true });
    writeFileSync(join(projectBundleDir, AGENT_CONFIG_BUNDLE_FILE_NAME), JSON.stringify({ project: "project-guru" }));
    const explicitPath = join(directory, "does-not-exist.json");

    const result = loadAgentConfigBundle({ cwd: directory, bundlePath: explicitPath });

    expect(result.status).toBe("missing");
    expect(result.source).toBe("defaults");
    expect(result.path).toBe(explicitPath);

    rmSync(directory, { recursive: true, force: true });
  });

  it("returns RED and refuses to load a bundle containing an embedded secret value", () => {
    const directory = makeTempDirectory();
    const bundlePath = join(directory, AGENT_CONFIG_BUNDLE_FILE_NAME);
    writeFileSync(
      bundlePath,
      JSON.stringify({
        project: "leaky",
        providers: [{ name: "openai", kind: "openai-compatible", apiKeyEnvVar: "OPENAI_API_KEY", notes: "key sk-1234567890abcdefghij here" }]
      })
    );

    const result = loadAgentConfigBundle({ cwd: directory, bundlePath });

    expect(result.status).toBe("invalid");
    expect(result.verdict).toBe("RED");
    expect(result.diagnostics.join("\n")).toContain("embedded secret value detected");
    expect(result.diagnostics.join("\n")).not.toContain("sk-1234567890");

    rmSync(directory, { recursive: true, force: true });
  });

  it("returns RED for a malformed (non-JSON) bundle", () => {
    const directory = makeTempDirectory();
    const bundlePath = join(directory, AGENT_CONFIG_BUNDLE_FILE_NAME);
    writeFileSync(bundlePath, "{ not json");

    const result = loadAgentConfigBundle({ cwd: directory, bundlePath });

    expect(result.status).toBe("invalid");
    expect(result.verdict).toBe("RED");
    expect(result.diagnostics.join("\n")).toContain("Malformed");

    rmSync(directory, { recursive: true, force: true });
  });

  it("strips a UTF-8 BOM before parsing (Windows Notepad default)", () => {
    const directory = makeTempDirectory();
    const bundlePath = join(directory, AGENT_CONFIG_BUNDLE_FILE_NAME);
    const bom = "﻿";
    writeFileSync(bundlePath, `${bom}${JSON.stringify({ project: "bom-safe" })}`);

    const result = loadAgentConfigBundle({ cwd: directory, bundlePath });

    expect(result.status).toBe("loaded");
    expect(result.bundle.project).toBe("bom-safe");

    rmSync(directory, { recursive: true, force: true });
  });
});

describe("saveAgentConfigBundle / exportAgentConfigBundle", () => {
  it("writes a valid bundle to disk and round-trips it through load", () => {
    const directory = makeTempDirectory();
    const bundlePath = join(directory, "nested", AGENT_CONFIG_BUNDLE_FILE_NAME);
    const bundle = AgentConfigBundleSchema.parse({
      project: "round-trip",
      providers: [{ name: "openai", kind: "openai-compatible", apiKeyEnvVar: "OPENAI_API_KEY" }],
      models: [{ role: "planner", provider: "openai", model: "gpt-5.6-sol" }]
    });

    saveAgentConfigBundle(bundlePath, bundle, { cwd: directory });

    const reloaded = loadAgentConfigBundle({ cwd: directory, bundlePath });
    expect(reloaded.status).toBe("loaded");
    expect(reloaded.bundle.project).toBe("round-trip");
    expect(reloaded.bundle.models[0]?.model).toBe("gpt-5.6-sol");

    rmSync(directory, { recursive: true, force: true });
  });

  it("throws EmbeddedSecretError and writes nothing if a secret value would land on disk", () => {
    const directory = makeTempDirectory();
    const bundlePath = join(directory, AGENT_CONFIG_BUNDLE_FILE_NAME);
    // Bypass the schema's env-name guard by constructing an object whose
    // serialized form smuggles a secret through a free-form-ish path the
    // schema still allows (a long model id). The save-time secret scan is the
    // defense-in-depth layer this test exercises.
    const bundle = {
      project: "leaky",
      providers: [{ name: "openai", kind: "openai-compatible", apiKeyEnvVar: "OPENAI_API_KEY" }],
      models: [{ role: "planner", provider: "openai", model: "sk-1234567890abcdefghij" }]
    } as unknown as Parameters<typeof saveAgentConfigBundle>[1];

    expect(() => saveAgentConfigBundle(bundlePath, bundle, { cwd: directory })).toThrow(EmbeddedSecretError);
    expect(() => saveAgentConfigBundle(bundlePath, bundle, { cwd: directory })).toThrow(/embedded secret value detected/);

    rmSync(directory, { recursive: true, force: true });
  });

  it("exportAgentConfigBundle returns stable JSON that parses back to an equal bundle", () => {
    const bundle = AgentConfigBundleSchema.parse({ project: "exported" });
    const exported = exportAgentConfigBundle(bundle);
    expect(JSON.parse(exported).project).toBe("exported");
    expect(exported.endsWith("\n")).toBe(true);
  });
});

function makeTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "guruharness-agent-config-bundle-"));
}
