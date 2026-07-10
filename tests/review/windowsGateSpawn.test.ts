import { describe, expect, it } from "vitest";

import { resolveWindowsGateSpawn } from "../../src/review/gates.js";

describe("resolveWindowsGateSpawn", () => {
  it("keeps bare node (native .exe) — never rewrites to node.cmd", () => {
    const resolved = resolveWindowsGateSpawn(["node", "-e", "1"]);
    // Must not be a batch shim (Node 20+ rejects .cmd with shell:false → EINVAL).
    expect(resolved.executable.toLowerCase().endsWith(".cmd")).toBe(false);
    expect(resolved.executable.toLowerCase().endsWith(".bat")).toBe(false);
    // Either bare "node" or a full path to node.exe
    expect(resolved.executable.toLowerCase().includes("node")).toBe(true);
    expect(resolved.args).toEqual(["-e", "1"]);
  });

  it("rewrites npm to node + npm-cli.js when available", () => {
    if (process.platform !== "win32") {
      const resolved = resolveWindowsGateSpawn(["npm", "test"]);
      expect(resolved.executable).toBe("npm");
      expect(resolved.args).toEqual(["test"]);
      return;
    }
    const resolved = resolveWindowsGateSpawn(["npm", "--version"]);
    // Prefer PE or node+cli — never npm.cmd
    expect(resolved.executable.toLowerCase().endsWith(".cmd")).toBe(false);
    if (resolved.executable === process.execPath || resolved.executable.toLowerCase().endsWith("node.exe")) {
      expect(resolved.args[0]?.toLowerCase()).toContain("npm-cli.js");
      expect(resolved.args.slice(1)).toEqual(["--version"]);
    }
  });

  it("passes through absolute paths unchanged", () => {
    const abs = process.execPath;
    const resolved = resolveWindowsGateSpawn([abs, "-e", "0"]);
    expect(resolved.executable).toBe(abs);
    expect(resolved.args).toEqual(["-e", "0"]);
  });
});
