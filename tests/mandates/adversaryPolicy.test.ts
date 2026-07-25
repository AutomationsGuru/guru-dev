import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ADVERSARY_REVIEWED_TOOLS,
  adversaryPolicyAllowsFailOpen,
  adversaryReviewedTools,
  defaultAdversaryPolicyPath,
  isAdversaryPolicyEnabled,
  loadAdversaryPolicy,
  riskClassForVerbs
} from '../../src/mandates/adversaryPolicy.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guru-adversary-policy-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeHomePolicy(body: string): string {
  const dir = join(root, ".guruharness");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "adversary.md");
  writeFileSync(path, body, "utf8");
  return path;
}

function writeProjectPolicy(body: string): string {
  const dir = join(root, "proj", ".guru");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "adversary.md");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("riskClassForVerbs", () => {
  it("classifies any hard-edge verb as hard-limit", () => {
    expect(riskClassForVerbs(["destructive"])).toBe("hard-limit");
    expect(riskClassForVerbs(["exec", "spend"])).toBe("hard-limit");
    expect(riskClassForVerbs(["write", "secret-edge"])).toBe("hard-limit");
    expect(riskClassForVerbs(["auth-edge"])).toBe("hard-limit");
  });

  it("classifies gated non-hard-edge verbs as unknown", () => {
    expect(riskClassForVerbs(["exec"])).toBe("unknown");
    expect(riskClassForVerbs(["write"])).toBe("unknown");
    expect(riskClassForVerbs(["net"])).toBe("unknown");
  });

  it("classifies only a verb-free call as standard — any verb is treated conservatively", () => {
    expect(riskClassForVerbs([])).toBe("standard");
    // "read" never appears in practice (read-only tools produce zero verbs); if it
    // ever did, it must NOT buy fail-open eligibility — conservative by design.
    expect(riskClassForVerbs(["read"])).toBe("unknown");
  });
});

describe("policy markdown parsing", () => {
  it("treats whitespace-only bodies as disabled", () => {
    expect(isAdversaryPolicyEnabled("")).toBe(false);
    expect(isAdversaryPolicyEnabled("   \n\t \n")).toBe(false);
    expect(isAdversaryPolicyEnabled("# deny destructive deploys\n")).toBe(true);
  });

  it("falls back to the default high-risk tool list when no header exists", () => {
    expect(adversaryReviewedTools("# block anything that touches prod\n")).toEqual(DEFAULT_ADVERSARY_REVIEWED_TOOLS);
  });

  it("reads a tools: header as the explicit review list", () => {
    expect(adversaryReviewedTools("tools: bash, edit\nsome policy text")).toEqual(["bash", "edit"]);
    expect(adversaryReviewedTools("review: write\n")).toEqual(["write"]);
  });

  it("parses the fail_open opt-in header", () => {
    expect(adversaryPolicyAllowsFailOpen("fail_open: true\n")).toBe(true);
    expect(adversaryPolicyAllowsFailOpen("fail-open: yes")).toBe(true);
    expect(adversaryPolicyAllowsFailOpen("fail_open: false")).toBe(false);
    expect(adversaryPolicyAllowsFailOpen("# no header here")).toBe(false);
  });
});

describe("loadAdversaryPolicy", () => {
  it("resolves the default home policy path under ~/.guruharness", () => {
    expect(defaultAdversaryPolicyPath("/home/op")).toBe(join("/home/op", ".guruharness", "adversary.md"));
  });

  it("is disabled with no sources at all", () => {
    const policy = loadAdversaryPolicy({ homeDirectory: join(root, "nohome"), cwd: join(root, "noproj") });
    expect(policy.enabled).toBe(false);
    expect(policy.reviewedTools).toEqual([]);
    expect(policy.sources).toEqual([]);
    expect(policy.failOpenSoft).toBe(false);
  });

  it("loads the home policy with default tools when no header is present", () => {
    const path = writeHomePolicy("# never allow mass deletes\n");
    const policy = loadAdversaryPolicy({ homeDirectory: root, cwd: join(root, "noproj") });
    expect(policy.enabled).toBe(true);
    expect(policy.reviewedTools).toEqual(DEFAULT_ADVERSARY_REVIEWED_TOOLS);
    expect(policy.homeBody).toContain("mass deletes");
    expect(policy.sources).toEqual([path]);
  });

  it("treats a whitespace-only policy file as disabled and contributes no tools", () => {
    writeHomePolicy("   \n\n");
    const policy = loadAdversaryPolicy({ homeDirectory: root, cwd: join(root, "noproj") });
    expect(policy.enabled).toBe(false);
    expect(policy.reviewedTools).toEqual([]);
  });

  it("merges the project overlay as a UNION of reviewed tools (tighten-only)", () => {
    writeHomePolicy("tools: bash\nhome policy");
    writeProjectPolicy("tools: write, custom_tool\nproject policy");
    const policy = loadAdversaryPolicy({ homeDirectory: root, cwd: join(root, "proj") });
    expect(policy.enabled).toBe(true);
    expect(policy.reviewedTools).toEqual(["bash", "write", "custom_tool"]);
    expect(policy.homeBody).toContain("home policy");
    expect(policy.overlayBody).toContain("project policy");
  });

  it("cannot be disabled by an empty project overlay when home enables it", () => {
    writeHomePolicy("tools: bash\nhome policy");
    writeProjectPolicy("\n");
    const policy = loadAdversaryPolicy({ homeDirectory: root, cwd: join(root, "proj") });
    expect(policy.enabled).toBe(true);
    expect(policy.reviewedTools).toEqual(["bash"]);
  });

  it("enables from the overlay alone (operator may run project-only policy)", () => {
    writeProjectPolicy("tools: bash\nproject-only policy");
    const policy = loadAdversaryPolicy({ homeDirectory: join(root, "nohome"), cwd: join(root, "proj") });
    expect(policy.enabled).toBe(true);
    expect(policy.reviewedTools).toEqual(["bash"]);
  });

  it("honors an explicit fail_open header from either source", () => {
    writeHomePolicy("tools: bash\nfail_open: true\n");
    const policy = loadAdversaryPolicy({ homeDirectory: root, cwd: join(root, "noproj") });
    expect(policy.failOpenSoft).toBe(true);
  });

  it("never throws on an unreadable/invalid path — that source just contributes nothing", () => {
    const policy = loadAdversaryPolicy({
      // A directory exists but is not readable as a file → the read throws and
      // is swallowed; a missing path likewise contributes nothing.
      homePolicyPath: root,
      projectPolicyPath: join(root, "also-missing", "adversary.md")
    });
    expect(policy.enabled).toBe(false);
    expect(policy.sources).toEqual([]);
  });
});
