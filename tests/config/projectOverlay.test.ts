import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyProjectOverlay, loadProjectOverlayConfig } from '../../src/config/projectOverlay.js';
import { HarnessConfigSchema, type HarnessConfig } from '../../src/config/schema.js';

function makeGlobal(overrides: Record<string, unknown> = {}): HarnessConfig {
  return HarnessConfigSchema.parse({ runtimeName: "GuruHarness", ...overrides });
}

describe("applyProjectOverlay", () => {
  describe("equal-or-tighter values are accepted", () => {
    it("applies identical scalar values without diagnostics", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { runtimeName: "GuruHarness" });

      expect(result.config.runtimeName).toBe("GuruHarness");
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts a numeric cap decreased toward the floor", () => {
      const global = makeGlobal({ selfBuild: { maxIterations: 5, completedTaskIds: [] } });
      const result = applyProjectOverlay(global, { selfBuild: { maxIterations: 2 } });

      expect(result.config.selfBuild.maxIterations).toBe(2);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts tightening a permission boolean from true to false", () => {
      const global = makeGlobal({ approvalPolicy: { autoCommitPushPr: true, allowLocalMerge: false, allowForcePush: false } });
      const result = applyProjectOverlay(global, { approvalPolicy: { autoCommitPushPr: false } });

      expect(result.config.approvalPolicy.autoCommitPushPr).toBe(false);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts requiring a review gate that was optional", () => {
      const global = makeGlobal({ reviewGate: { provider: "native-critic-panel", required: false } });
      const result = applyProjectOverlay(global, { reviewGate: { required: true } });

      expect(result.config.reviewGate.required).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts shrinking the shell allowlist to a subset", () => {
      const global = makeGlobal({ runtimeHardening: { shellAllowlist: ["git", "npm", "node"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { shellAllowlist: ["git"] } });

      expect(result.config.runtimeHardening.shellAllowlist).toEqual(["git"]);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts an equal shell allowlist regardless of order", () => {
      const global = makeGlobal({ runtimeHardening: { shellAllowlist: ["git", "npm"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { shellAllowlist: ["npm", "git"] } });

      expect(result.config.runtimeHardening.shellAllowlist).toEqual(["git", "npm"]);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts growing the risky-path pattern set (superset = stricter)", () => {
      const global = makeGlobal({ runtimeHardening: { riskyPathPatterns: [".git", ".env"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { riskyPathPatterns: [".git", ".env", ".ssh"] } });

      expect(result.config.runtimeHardening.riskyPathPatterns).toEqual([".git", ".env", ".ssh"]);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts shrinking the secret allowlist", () => {
      const global = makeGlobal({ runtimeHardening: { secretAllowList: ["A_KEY", "B_KEY"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { secretAllowList: ["A_KEY"] } });

      expect(result.config.runtimeHardening.secretAllowList).toEqual(["A_KEY"]);
      expect(result.diagnostics).toEqual([]);
    });

    it("accepts decreasing retry budgets", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { retry: { maxRetries: 1 } });

      expect(result.config.retry.maxRetries).toBe(1);
      expect(result.config.retry.maxRetries).toBeLessThanOrEqual(global.retry.maxRetries);
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe("widen attempts are dropped with diagnostics", () => {
    it("drops a numeric cap increase and keeps the global value", () => {
      const global = makeGlobal({ selfBuild: { maxIterations: 2, completedTaskIds: [] } });
      const result = applyProjectOverlay(global, { selfBuild: { maxIterations: 9 } });

      expect(result.config.selfBuild.maxIterations).toBe(2);
      expect(result.diagnostics.some((d) => d.includes("selfBuild.maxIterations"))).toBe(true);
    });

    it("drops flipping a permission boolean false -> true (permission broadening)", () => {
      const global = makeGlobal({ approvalPolicy: { autoCommitPushPr: false, allowLocalMerge: false, allowForcePush: false } });
      const result = applyProjectOverlay(global, { approvalPolicy: { allowForcePush: true } });

      expect(result.config.approvalPolicy.allowForcePush).toBe(false);
      expect(result.diagnostics.some((d) => d.includes("approvalPolicy.allowForcePush"))).toBe(true);
    });

    it("drops making a required review gate optional", () => {
      const global = makeGlobal({ reviewGate: { provider: "native-critic-panel", required: true } });
      const result = applyProjectOverlay(global, { reviewGate: { required: false } });

      expect(result.config.reviewGate.required).toBe(true);
      expect(result.diagnostics.some((d) => d.includes("reviewGate.required"))).toBe(true);
    });

    it("drops widening the shell allowlist (superset or different membership)", () => {
      const global = makeGlobal({ runtimeHardening: { shellAllowlist: ["git"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { shellAllowlist: ["git", "curl"] } });

      expect(result.config.runtimeHardening.shellAllowlist).toEqual(["git"]);
      expect(result.diagnostics.some((d) => d.includes("runtimeHardening.shellAllowlist"))).toBe(true);
    });

    it("drops shrinking the risky-path pattern set (fewer guarded paths = weaker)", () => {
      const global = makeGlobal({ runtimeHardening: { riskyPathPatterns: [".git", ".env", ".ssh"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { riskyPathPatterns: [".git"] } });

      expect(result.config.runtimeHardening.riskyPathPatterns).toEqual([".git", ".env", ".ssh"]);
      expect(result.diagnostics.some((d) => d.includes("runtimeHardening.riskyPathPatterns"))).toBe(true);
    });

    it("drops growing the secret allowlist", () => {
      const global = makeGlobal({ runtimeHardening: { secretAllowList: ["A_KEY"] } });
      const result = applyProjectOverlay(global, { runtimeHardening: { secretAllowList: ["A_KEY", "B_KEY"] } });

      expect(result.config.runtimeHardening.secretAllowList).toEqual(["A_KEY"]);
      expect(result.diagnostics.some((d) => d.includes("runtimeHardening.secretAllowList"))).toBe(true);
    });

    it("drops swapping the review gate to an external command provider", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, {
        reviewGate: { provider: "command", command: ["echo", "ok"] }
      });

      expect(result.config.reviewGate.provider).toBe("native-critic-panel");
      expect(result.diagnostics.some((d) => d.includes("reviewGate.provider"))).toBe(true);
    });

    it("drops increasing retry budgets", () => {
      const global = makeGlobal({ retry: { maxRetries: 1 } });
      const result = applyProjectOverlay(global, { retry: { maxRetries: 6 } });

      expect(result.config.retry.maxRetries).toBe(1);
      expect(result.diagnostics.some((d) => d.includes("retry.maxRetries"))).toBe(true);
    });
  });

  describe("hard-rejected keys never reach the merged config", () => {
    it("rejects api_key-style credential keys", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { api_key: "sk-test", apiKey: "sk-test2" });

      expect(JSON.stringify(result.config)).not.toContain("sk-test");
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects base_url-style endpoint overrides", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { base_url: "https://evil.example" });

      expect(result.diagnostics.some((d) => d.includes("base_url"))).toBe(true);
    });

    it("rejects plannerModel provider/key injection", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { plannerModel: { provider: "evil", model: "x", apiKey: "k" } });

      expect(result.config.plannerModel).toBeUndefined();
      expect(result.diagnostics.some((d) => d.includes("plannerModel"))).toBe(true);
    });

    it("rejects mcpServers additions (untrusted server injection)", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, {
        mcpServers: [{ name: "evil", command: ["npx", "evil-mcp"] }]
      });

      expect(result.config.mcpServers).toEqual([]);
      expect(result.diagnostics.some((d) => d.includes("mcpServers"))).toBe(true);
    });

    it("rejects allow_shell-style shell-widening keys", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { allow_shell: true, allowShell: true });

      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    });

    it("rejects secret-bearing nested keys inside otherwise-mergeable sections", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, {
        memory: { honcho: { enabled: true, apiKey: "raw-secret-value" } }
      });

      expect(JSON.stringify(result.config)).not.toContain("raw-secret-value");
    });
  });

  describe("merge safety invariants", () => {
    it("never mutates the input global config", () => {
      const global = makeGlobal({ runtimeHardening: { shellAllowlist: ["git", "npm"] } });
      const snapshot = JSON.parse(JSON.stringify(global));

      applyProjectOverlay(global, { runtimeHardening: { shellAllowlist: ["git"] } });

      expect(global).toEqual(snapshot);
    });

    it("returns a config that still parses against HarnessConfigSchema", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, {
        selfBuild: { maxIterations: 1 },
        approvalPolicy: { autoCommitPushPr: false }
      });

      expect(() => HarnessConfigSchema.parse(result.config)).not.toThrow();
    });

    it("treats an empty overlay as a no-op", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, {});

      expect(result.config).toEqual(global);
      expect(result.diagnostics).toEqual([]);
    });

    it("ignores unknown keys rather than applying them", () => {
      const global = makeGlobal();
      const result = applyProjectOverlay(global, { totallyUnknownKey: { nested: true } });

      expect((result.config as Record<string, unknown>).totallyUnknownKey).toBeUndefined();
      expect(result.diagnostics.some((d) => d.includes("totallyUnknownKey"))).toBe(true);
    });
  });
});

describe("loadProjectOverlayConfig", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "guru-overlay-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("rejects a symlinked project config file", () => {
    const realConfig = join(workDir, "real-config.json");
    const linkPath = join(workDir, "guruharness.config.json");
    writeFileSync(realConfig, JSON.stringify({ runtimeName: "GuruHarness" }));
    symlinkSync(realConfig, linkPath);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const result = loadProjectOverlayConfig(linkPath);

    expect(result.status).toBe("rejected");
    expect(result.reason.toLowerCase()).toContain("symlink");
  });

  it("loads a regular project config file", () => {
    const configPath = join(workDir, "guruharness.config.json");
    writeFileSync(configPath, JSON.stringify({ runtimeName: "GuruHarness" }));

    const result = loadProjectOverlayConfig(configPath);

    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.overlay).toEqual({ runtimeName: "GuruHarness" });
    }
  });

  it("rejects invalid JSON without throwing", () => {
    const configPath = join(workDir, "guruharness.config.json");
    writeFileSync(configPath, "{ not json");

    const result = loadProjectOverlayConfig(configPath);

    expect(result.status).toBe("rejected");
  });

  it("rejects a symlinked .guru directory in the config path", () => {
    const realDir = join(workDir, "real-guru");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "guruharness.config.json"), JSON.stringify({ runtimeName: "GuruHarness" }));
    const linkDir = join(workDir, ".guru");
    symlinkSync(realDir, linkDir, "dir");

    const result = loadProjectOverlayConfig(join(linkDir, "guruharness.config.json"));

    expect(result.status).toBe("rejected");
    expect(result.reason.toLowerCase()).toContain("symlink");
  });
});
