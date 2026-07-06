import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessConfigSchema, type ValidationCommand } from "../config/schema.js";
import { runReviewGates, type CommandExecutor, type ReviewGatesReport } from "../review/gates.js";

/**
 * Discover a repo's OWN gates instead of assuming them (self-build P2, Foundational
 * Laws 1 & 2). Reads only what the PROJECT declares — package.json scripts, then
 * Makefile / Cargo.toml / go.mod / pyproject — and maps them to runnable argv, so guru
 * never assumes npm/tsc/cargo. Nothing declared → [] (the TEST stage then degrades to
 * YELLOW, never a crash or a false GREEN). Read-only; FS is injectable for tests.
 */

export interface DiscoverGatesOptions {
  readonly readFile?: (path: string) => string;
  readonly exists?: (path: string) => boolean;
}

const NPM_GATES: ReadonlyArray<{ readonly script: string; readonly name: string; readonly required: boolean }> = [
  { script: "typecheck", name: "typecheck", required: true },
  { script: "build", name: "build", required: true },
  { script: "test", name: "test", required: true },
  { script: "lint", name: "lint", required: false }
];

export function discoverGates(repoRoot: string, options: DiscoverGatesOptions = {}): ValidationCommand[] {
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const read = (rel: string): string | null => {
    const path = join(repoRoot, rel);
    if (!exists(path)) {
      return null;
    }
    try {
      return readFile(path);
    } catch {
      return null;
    }
  };

  // 1. Node — run the project's DECLARED package.json scripts (a valid package.json is
  //    definitive: a scriptless Node repo returns [], it does not fall through).
  const pkgRaw = read("package.json");
  if (pkgRaw) {
    try {
      const scripts = ((JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }).scripts ?? {});
      return NPM_GATES.filter((gate) => typeof scripts[gate.script] === "string").map((gate) => ({
        name: gate.name,
        command: ["npm", "run", gate.script],
        required: gate.required
      }));
    } catch {
      // malformed package.json → try another ecosystem
    }
  }

  // 2. Rust
  if (read("Cargo.toml")) {
    return [
      { name: "build", command: ["cargo", "build"], required: true },
      { name: "test", command: ["cargo", "test"], required: true }
    ];
  }
  // 3. Go
  if (read("go.mod")) {
    return [
      { name: "build", command: ["go", "build", "./..."], required: true },
      { name: "vet", command: ["go", "vet", "./..."], required: false },
      { name: "test", command: ["go", "test", "./..."], required: true }
    ];
  }
  // 4. Python
  if (read("pyproject.toml") || read("setup.py")) {
    return [{ name: "test", command: ["pytest"], required: true }];
  }
  // 5. Make (fallback — only recognized targets that actually exist)
  const makefile = read("Makefile");
  if (makefile) {
    const targets = ["build", "test", "typecheck", "lint", "check"].filter((target) => new RegExp(`^${target}:`, "mu").test(makefile));
    if (targets.length > 0) {
      return targets.map((target) => ({ name: target, command: ["make", target], required: target !== "lint" }));
    }
  }

  return [];
}

export interface RunDiscoveredValidationOptions extends DiscoverGatesOptions {
  readonly executor?: CommandExecutor;
  /** Pre-discovered gates (skip discovery); mainly for tests. */
  readonly gates?: readonly ValidationCommand[];
}

/**
 * TEST stage: discover the project's gates and run them. No gates declared → an empty
 * run → YELLOW (deriveVerdict on []), never RED-by-absence. The review gate is excluded
 * here (TEST is objective validation only; native review is its own stage).
 */
export async function runDiscoveredValidation(repoRoot: string, options: RunDiscoveredValidationOptions = {}): Promise<ReviewGatesReport> {
  const gates = options.gates ?? discoverGates(repoRoot, options);
  const config = HarnessConfigSchema.parse({ validationCommands: gates as ValidationCommand[] });
  return runReviewGates(config, {
    cwd: repoRoot,
    includeReviewGate: false,
    ...(options.executor ? { executor: options.executor } : {})
  });
}
