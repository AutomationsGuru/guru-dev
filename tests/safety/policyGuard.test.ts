import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectPotentialSecrets, guardContent, guardWritePath, isRiskyPath } from "../../src/safety/policyGuard.js";

const tempDirectories: string[] = [];

const riskyPathPatterns = [".git", ".env", "secrets", "credentials", "id_rsa"];

afterEach(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.length = 0;
});

describe("policyGuard", () => {
  it("detects risky paths using the existing path policy semantics", () => {
    expect(isRiskyPath(join("repo", ".env"), riskyPathPatterns)).toBe(true);
    expect(isRiskyPath(join("repo", ".git", "config"), riskyPathPatterns)).toBe(true);
    expect(isRiskyPath(join("repo", "secrets", "token.txt"), riskyPathPatterns)).toBe(true);
    expect(isRiskyPath(join("repo", "src", "index.ts"), riskyPathPatterns)).toBe(false);
  });

  it("detects potential secrets without returning raw values", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const matches = detectPotentialSecrets([{ name: "token", value: secret }]);

    expect(matches).toEqual([{ name: "token", kind: "github-token" }]);
    expect(JSON.stringify(matches)).not.toContain(secret);
  });

  it("honors exact secret allow-list values", () => {
    const value = "api_key=1234567890abcdef";

    expect(detectPotentialSecrets([{ name: "allowed", value }], [value])).toEqual([]);
  });

  it("blocks paths that escape the repository root", () => {
    const repoRoot = makeTempDirectory();
    const decision = guardWritePath("../outside.txt", {
      repoRoot,
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: false
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join("\n")).toContain("escapes the repository root");
    expect(decision.blockers.join("\n")).not.toContain("outside.txt");
  });

  it("blocks risky paths unless explicitly allowed", () => {
    const repoRoot = makeTempDirectory();
    const blocked = guardWritePath(".env", {
      repoRoot,
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: false
    });
    const allowed = guardWritePath(".env", {
      repoRoot,
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: true
    });

    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it("redacts detected secret values in content blockers", () => {
    const secret = "sk_test_1234567890abcdefghijklmnop";
    const decision = guardContent([{ name: "contents", value: `token=${secret}` }], {
      repoRoot: makeTempDirectory(),
      riskyPathPatterns,
      secretAllowList: [],
      allowRiskyPaths: false
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join("\n")).toContain("stripe-secret-key");
    expect(decision.blockers.join("\n")).not.toContain(secret);
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guruharness-policy-"));
  tempDirectories.push(directory);

  return directory;
}
