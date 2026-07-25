import { describe, expect, it } from "vitest";

import {
  SECURITY_SCAN_TOOL_ID,
  isSecurityScanOptInEnabled,
  maybeRegisterSecurityScanOptInTool,
  registerSecurityScanOptInTool,
  runSecurityScan,
  type SecurityScanDeps
} from '../../src/garage/securityScanOptInTool.js';

/**
 * Helper — build a minimal ExtensionApi stand-in that records registrations,
 * so we can assert presence/absence of the opt-in tool id without dragging in
 * the full extension host. The stand-in mirrors the structural shape of the
 * `ExtensionApi.registerTool` contract (factory only, no other side effects).
 */
function buildStubApi() {
  const factories: Array<() => readonly unknown[]> = [];
  const api = {
    registerTool(spec: { factory: () => readonly unknown[] }) {
      factories.push(spec.factory);
    }
  };
  return { api, factories };
}

function flatToolIds(factories: ReadonlyArray<() => readonly unknown[]>): string[] {
  const ids: string[] = [];
  for (const factory of factories) {
    for (const tool of factory()) {
      if (tool && typeof tool === "object" && "id" in tool && typeof (tool as { id: unknown }).id === "string") {
        ids.push((tool as { id: string }).id);
      }
    }
  }
  return ids.sort();
}

describe("isSecurityScanOptInEnabled (default-off gate)", () => {
  it("returns true ONLY when the flag is exactly true", () => {
    expect(isSecurityScanOptInEnabled(true)).toBe(true);
  });

  it("rejects truthy-but-not-true, undefined, null, false, and 1", () => {
    expect(isSecurityScanOptInEnabled(undefined)).toBe(false);
    expect(isSecurityScanOptInEnabled(null)).toBe(false);
    expect(isSecurityScanOptInEnabled(false)).toBe(false);
    expect(isSecurityScanOptInEnabled(1)).toBe(false);
    expect(isSecurityScanOptInEnabled("true")).toBe(false);
    expect(isSecurityScanOptInEnabled({})).toBe(false);
    expect(isSecurityScanOptInEnabled([])).toBe(false);
  });
});

describe("maybeRegisterSecurityScanOptInTool — opt-in behaviour", () => {
  it("DEFAULT DISABLED: when flag is false / missing, no tool is registered", () => {
    const cases: ReadonlyArray<unknown> = [undefined, false, null, 0, "", "yes"];
    for (const flag of cases) {
      const stub = buildStubApi();
      const registered = maybeRegisterSecurityScanOptInTool(stub.api as never, flag);
      expect(registered).toBe(false);
      expect(stub.factories).toHaveLength(0);
      expect(flatToolIds(stub.factories)).not.toContain(SECURITY_SCAN_TOOL_ID);
    }
  });

  it("ENABLED: when flag is true, the security_scan tool id is exposed exactly once", () => {
    const stub = buildStubApi();
    const registered = maybeRegisterSecurityScanOptInTool(stub.api as never, true);
    expect(registered).toBe(true);
    expect(stub.factories).toHaveLength(1);
    const ids = flatToolIds(stub.factories);
    expect(ids).toEqual([SECURITY_SCAN_TOOL_ID]);
  });

  it("registerSecurityScanOptInTool exposes the tool id (the flag gate is the only thing that matters)", () => {
    const stub = buildStubApi();
    expect(registerSecurityScanOptInTool(stub.api as never)).toBe(true);
    expect(flatToolIds(stub.factories)).toContain(SECURITY_SCAN_TOOL_ID);
  });
});

describe("SECURITY_SCAN_TOOL_ID constant", () => {
  it("is the stable wire id for the opt-in tool", () => {
    expect(SECURITY_SCAN_TOOL_ID).toBe("security_scan");
  });
});

describe("runSecurityScan — pure scanner", () => {
  it("reports zero counts when no IO is wired (test/default path)", async () => {
    const report = await runSecurityScan(".", { deps: {} as SecurityScanDeps });
    expect(report.filesScanned).toBe(0);
    expect(report.filesSkipped).toBe(0);
    expect(report.matches).toEqual({
      "hard-coded-secret": 0,
      "unsafe-process-spawn": 0,
      "insecure-url": 0
    });
    expect(report.truncated).toBe(false);
    expect(report.summary).toMatch(/security scan disabled/i);
  });

  it("counts matches by category and NEVER echoes the matched values", async () => {
    const fakeBody = [
      "const token = 'AKIAIOSFODNN7EXAMPLE';",
      "child_process.execSync('ls');",
      "const url = 'http://insecure.example.com/path';"
    ].join("\n");

    const deps: SecurityScanDeps = {
      async readdir() {
        return ["a.ts"];
      },
      async stat() {
        return { isFile: () => true, isDirectory: () => false };
      },
      async readFile() {
        return fakeBody;
      }
    };

    const report = await runSecurityScan(".", { deps });
    expect(report.filesScanned).toBe(1);
    expect(report.matches["hard-coded-secret"]).toBe(1);
    expect(report.matches["unsafe-process-spawn"]).toBe(1);
    expect(report.matches["insecure-url"]).toBe(1);
    // CRUCIAL: the matched values must not appear anywhere in the report.
    const reportJson = JSON.stringify(report);
    expect(reportJson).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(reportJson).not.toContain("insecure.example.com");
    expect(reportJson).not.toContain("child_process");
  });

  it("truncates when the file cap is reached and reports truncated=true", async () => {
    const deps: SecurityScanDeps = {
      async readdir() {
        return ["a.ts"];
      },
      async stat() {
        return { isFile: () => true, isDirectory: () => false };
      },
      async readFile() {
        return "// empty";
      }
    };

    const report = await runSecurityScan(".", { maxFiles: 1, deps });
    expect(report.filesScanned).toBe(1);
    expect(report.truncated).toBe(true);
    expect(report.summary).toMatch(/truncated/i);
  });
});

describe("default-off invariant (acceptance: register only when flag is on)", () => {
  it("default OFF is the only state reached when the boot code omits the flag", () => {
    const stub = buildStubApi();
    maybeRegisterSecurityScanOptInTool(stub.api as never, undefined);
    expect(flatToolIds(stub.factories)).not.toContain(SECURITY_SCAN_TOOL_ID);
  });

  it("flag=true is the only path that exposes the tool id", () => {
    const stub = buildStubApi();
    maybeRegisterSecurityScanOptInTool(stub.api as never, true);
    expect(flatToolIds(stub.factories)).toEqual([SECURITY_SCAN_TOOL_ID]);
  });
});