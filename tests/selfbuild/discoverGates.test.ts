import { describe, expect, it } from "vitest";

import { discoverGates, runDiscoveredValidation } from "../../src/selfbuild/discoverGates.js";
import type { CommandExecutor } from "../../src/review/gates.js";

/** A fake read-only FS keyed by file basename (matches the paths discoverGates builds). */
function fakeFs(files: Record<string, string>) {
  const match = (path: string): string | undefined => {
    const norm = path.replace(/\\/gu, "/");
    return Object.keys(files).find((f) => norm.endsWith(`/${f}`) || norm.endsWith(f));
  };
  return {
    exists: (path: string) => match(path) !== undefined,
    readFile: (path: string) => {
      const key = match(path);
      if (!key) {
        throw new Error("ENOENT");
      }
      return files[key]!;
    }
  };
}

describe("discoverGates (P2) — read the project's OWN gates, never assume a tool", () => {
  it("npm repo with only `test` → exactly `npm run test`", () => {
    const gates = discoverGates("/repo", fakeFs({ "package.json": JSON.stringify({ scripts: { test: "vitest", start: "node ." } }) }));
    expect(gates).toEqual([{ name: "test", command: ["npm", "run", "test"], required: true }]);
  });

  it("npm repo with typecheck/build/test/lint → all four, lint optional", () => {
    const gates = discoverGates("/repo", fakeFs({ "package.json": JSON.stringify({ scripts: { typecheck: "tsc", build: "tsc -b", test: "vitest", lint: "eslint" } }) }));
    expect(gates.map((g) => g.name)).toEqual(["typecheck", "build", "test", "lint"]);
    expect(gates.find((g) => g.name === "lint")?.required).toBe(false);
    expect(gates.find((g) => g.name === "test")?.required).toBe(true);
  });

  it("a scriptless Node repo → [] (TEST will be YELLOW, never a false GREEN)", () => {
    expect(discoverGates("/repo", fakeFs({ "package.json": JSON.stringify({ scripts: { start: "node ." } }) }))).toEqual([]);
  });

  it("a Rust repo → cargo build + cargo test", () => {
    const gates = discoverGates("/repo", fakeFs({ "Cargo.toml": "[package]\nname='x'" }));
    expect(gates.map((g) => g.command.join(" "))).toEqual(["cargo build", "cargo test"]);
  });

  it("a Go repo → go build/vet/test", () => {
    const gates = discoverGates("/repo", fakeFs({ "go.mod": "module x" }));
    expect(gates.map((g) => g.name)).toEqual(["build", "vet", "test"]);
  });

  it("a Python repo → pytest", () => {
    expect(discoverGates("/repo", fakeFs({ "pyproject.toml": "[project]" }))[0]?.command).toEqual(["pytest"]);
  });

  it("a Makefile with test/build targets → make test/build", () => {
    const gates = discoverGates("/repo", fakeFs({ Makefile: "build:\n\ttsc\ntest:\n\tvitest\n" }));
    expect(gates.map((g) => g.command.join(" ")).sort()).toEqual(["make build", "make test"]);
  });

  it("a repo with NOTHING recognized → [] (never crashes)", () => {
    expect(discoverGates("/repo", fakeFs({ "README.md": "# hi" }))).toEqual([]);
    expect(discoverGates("/repo", fakeFs({ "package.json": "{ this is not json" }))).toEqual([]); // malformed → falls through, still []
  });
});

describe("runDiscoveredValidation (P2 TEST stage)", () => {
  const passing: CommandExecutor = async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 });
  const failGate = (name: string): CommandExecutor => async (_c, ctx) => ({ exitCode: ctx.gate.name === name ? 1 : 0, stdout: "", stderr: "", durationMs: 0 });
  const npmGates = [{ name: "test", command: ["npm", "run", "test"], required: true }];

  it("all discovered gates pass → GREEN", async () => {
    const report = await runDiscoveredValidation("/repo", { gates: npmGates, executor: passing });
    expect(report.verdict).toBe("GREEN");
  });

  it("a required discovered gate fails → RED (routed to DEBUG)", async () => {
    const report = await runDiscoveredValidation("/repo", { gates: npmGates, executor: failGate("test") });
    expect(report.verdict).toBe("RED");
  });

  it("no gates discovered → YELLOW, never RED-by-absence", async () => {
    const report = await runDiscoveredValidation("/repo", { gates: [], executor: passing });
    expect(report.verdict).toBe("YELLOW");
  });
});
