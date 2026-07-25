import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  QUALITY_TIERS,
  QualityTierSchema,
  resolveQualityTierPolicy
} from "../../src/config/qualityTier.js";
import { createProposeAllowlistTool } from "../../src/tools/builtins/proposeAllowlistTool.js";

describe("QualityTierSchema", () => {
  it("accepts the three named tiers", () => {
    for (const tier of QUALITY_TIERS) {
      expect(QualityTierSchema.parse(tier)).toBe(tier);
    }
  });

  it("rejects unknown tier names", () => {
    expect(() => QualityTierSchema.parse("auto-everything")).toThrow();
    expect(() => QualityTierSchema.parse("")).toThrow();
    expect(() => QualityTierSchema.parse(1)).toThrow();
  });
});

describe("resolveQualityTierPolicy", () => {
  it("local-only forbids every self-build automation step", () => {
    const policy = resolveQualityTierPolicy("local-only");
    expect(policy.tier).toBe("local-only");
    expect(policy.selfBuild.maxIterationsCeiling).toBe(0);
    expect(policy.selfBuild.autoCommitPushPr).toBe(false);
    expect(policy.selfBuild.allowLocalMerge).toBe(false);
    expect(policy.selfBuild.allowForcePush).toBe(false);
    expect(policy.selfBuild.requiresOperatorApproval).toBe(true);
  });

  it("pr permits bounded local iteration but keeps git delivery manual", () => {
    const policy = resolveQualityTierPolicy("pr");
    expect(policy.selfBuild.maxIterationsCeiling).toBeGreaterThan(0);
    expect(policy.selfBuild.autoCommitPushPr).toBe(false);
    expect(policy.selfBuild.allowLocalMerge).toBe(false);
    expect(policy.selfBuild.allowForcePush).toBe(false);
    expect(policy.selfBuild.requiresOperatorApproval).toBe(true);
  });

  it("gated-selfbuild permits configured automation but NEVER force push or local merge", () => {
    const policy = resolveQualityTierPolicy("gated-selfbuild");
    expect(policy.selfBuild.maxIterationsCeiling).toBeGreaterThan(0);
    expect(policy.selfBuild.autoCommitPushPr).toBe(true);
    // Hard floors: no tier may lift these (governance hard limits).
    expect(policy.selfBuild.allowLocalMerge).toBe(false);
    expect(policy.selfBuild.allowForcePush).toBe(false);
    expect(policy.selfBuild.requiresOperatorApproval).toBe(true);
  });

  it("never weakens review gates at any tier (review stays required)", () => {
    for (const tier of QUALITY_TIERS) {
      expect(resolveQualityTierPolicy(tier).selfBuild.reviewGateRequired).toBe(true);
    }
  });

  it("clamps a requested iteration count to the tier ceiling", () => {
    expect(resolveQualityTierPolicy("local-only").clampMaxIterations(5)).toBe(0);
    expect(resolveQualityTierPolicy("pr").clampMaxIterations(99)).toBe(resolveQualityTierPolicy("pr").selfBuild.maxIterationsCeiling);
    expect(resolveQualityTierPolicy("gated-selfbuild").clampMaxIterations(1)).toBe(1);
    // A request within the ceiling passes through unchanged.
    const pr = resolveQualityTierPolicy("pr");
    expect(pr.clampMaxIterations(pr.selfBuild.maxIterationsCeiling)).toBe(pr.selfBuild.maxIterationsCeiling);
  });
});

/**
 * proposeAllowlistTool coverage lives beside the allowlist's owning config
 * surface (`runtimeHardening.shellAllowlist` in src/config/schema.ts) — the
 * plan owns exactly three test files, and this is the config-adjacent one.
 * Structural rule under test: the tool PROPOSES from observed tool uses but
 * NEVER mutates the live config or a hard edge (R-CC-ALLOW).
 */
describe("propose_allowlist tool (never auto-applies hard edges)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guru-allow-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const TOOL_USES = [
    { toolId: "shell.exec", executable: "npm", count: 12 },
    { toolId: "shell.exec", executable: "git", count: 8 },
    { toolId: "shell.exec", executable: "node", count: 3 },
    { toolId: "file.edit", executable: null, count: 20 }
  ];

  it("aggregates transcript tool uses into allowlist suggestions", async () => {
    const tool = createProposeAllowlistTool();
    const out = await tool.execute({ toolUses: TOOL_USES, minCount: 2 }, {});
    expect(out.suggestions).toContain("npm");
    expect(out.suggestions).toContain("git");
    expect(out.suggestions).toContain("node");
    const npmRow = out.entries.find((entry) => entry.executable === "npm");
    expect(npmRow?.count).toBe(12);
    expect(out.applied).toBe(false);
  });

  it("filters out executables below the min count", async () => {
    const tool = createProposeAllowlistTool();
    const out = await tool.execute({ toolUses: TOOL_USES, minCount: 5 }, {});
    expect(out.suggestions).toContain("npm");
    expect(out.suggestions).toContain("git");
    expect(out.suggestions).not.toContain("node");
  });

  it("excludes non-shell tools from shell-allowlist suggestions", async () => {
    const tool = createProposeAllowlistTool();
    const out = await tool.execute({ toolUses: TOOL_USES, minCount: 1 }, {});
    expect(out.suggestions).not.toContain("file.edit");
  });

  it("writes a suggestions FILE and never mutates the live config", async () => {
    const configPath = join(dir, "guruharness.config.json");
    writeFileSync(configPath, JSON.stringify({ runtimeName: "GuruHarness" }), "utf8");
    const outPath = join(dir, "allowlist-suggestions.json");

    const tool = createProposeAllowlistTool();
    const out = await tool.execute({ toolUses: TOOL_USES, minCount: 1, outputPath: outPath, configPath }, {});

    expect(out.outputPath).toBe(outPath);
    const written = JSON.parse(readFileSync(outPath, "utf8")) as { suggestions: string[]; note: string };
    expect(written.suggestions).toContain("npm");
    expect(written.note).toMatch(/suggestion|review|operator/i);
    // Live config is untouched — proposals never auto-apply hard-edge changes.
    expect(readFileSync(configPath, "utf8")).not.toContain("shellAllowlist");
    expect(out.applied).toBe(false);
  });

  it("refuses to overwrite an existing suggestions file", async () => {
    const outPath = join(dir, "allowlist-suggestions.json");
    writeFileSync(outPath, "{}", "utf8");
    const tool = createProposeAllowlistTool();
    await expect(tool.execute({ toolUses: TOOL_USES, minCount: 1, outputPath: outPath }, {})).rejects.toThrow(/exists|overwrite/i);
  });

  it("scrubs secret-shaped executable names from the suggestions output", async () => {
    const tool = createProposeAllowlistTool();
    const out = await tool.execute(
      { toolUses: [{ toolId: "shell.exec", executable: "sk-ant-abcdefghijklmnop1234567890", count: 9 }], minCount: 1 },
      {}
    );
    expect(JSON.stringify(out)).not.toContain("sk-ant-abcdefghijklmnop1234567890");
  });

  it("declares an honest mutating effect marker (it writes a suggestions file)", () => {
    // The analysis never reads or mutates live config, but the tool DOES write
    // a new suggestions file — so the G1004 plan-mode marker must say
    // "mutating". Marking a file-writing tool "read-only" would be a structural
    // lie the plan-mode certification gate exists to catch.
    expect(createProposeAllowlistTool().effect).toBe("mutating");
  });

  it("rejects empty tool-usage input at the schema boundary", () => {
    const tool = createProposeAllowlistTool();
    expect(() => tool.inputSchema.parse({ toolUses: [], minCount: 1 })).toThrow();
  });
});
