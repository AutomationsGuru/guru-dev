#!/usr/bin/env node
/** `npm run dogfood:portfolio` — multi-repo dogfood orchestrator smoke (`src/dogfood/`). */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  composeDogfoodOrchestrators,
  createDefaultDogfoodOrchestrators,
  type DogfoodRepoCandidate,
  type DogfoodTier
} from "../src/dogfood/orchestrators.js";
import { createHarnessRuntime } from "../src/index.js";

interface ResolvedPortfolioRepo {
  readonly candidate: DogfoodRepoCandidate;
  readonly path: string;
  readonly displayPath: string;
  readonly source: "local" | "remote-temp";
}

interface SkippedPortfolioRepo {
  readonly label: string;
  readonly orchestrator: string;
  readonly tier: DogfoodTier;
  readonly reason: string;
}

interface PortfolioRepoResult {
  readonly label: string;
  readonly orchestrator: string;
  readonly tier: DogfoodTier;
  readonly repo: string;
  readonly source: "local" | "remote-temp";
  readonly session: string;
  readonly task: string | null;
  readonly repoContext: string;
  readonly shellDryRun: string;
  readonly agents: number;
  readonly gitStatusFirstLine: string | null;
  readonly signal: string;
  readonly signalHits: number;
}

const includeRemote = process.argv.includes("--include-remote");
const orchestratorFilter = getFlagValue("--orchestrator");
const tierFilter = parseTierFilter(getFlagValue("--tier"));
const orchestrators = createDefaultDogfoodOrchestrators().filter((orchestrator) => !orchestratorFilter || orchestrator.id === orchestratorFilter);
const candidates = composeDogfoodOrchestrators(orchestrators).filter((candidate) => !tierFilter || candidate.tier === tierFilter);

const home = homedir();
const runtime = createHarnessRuntime();
const results: PortfolioRepoResult[] = [];
const skipped: SkippedPortfolioRepo[] = [];
const tempRoots: string[] = [];
const cloneFailureReasons = new Map<string, string>();

try {
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate);
    if (!resolved) {
      skipped.push({
        label: candidate.label,
        orchestrator: candidate.orchestratorId,
        tier: candidate.tier,
        reason: cloneFailureReasons.get(candidate.label) ?? (candidate.remoteUrl && !includeRemote ? "remote target requires --include-remote" : "local target not found")
      });
      continue;
    }

    const session = await runtime.startSession({ cwd: resolved.path });
    const context = await runtime.executeTool(session.id, "repo.context.resolve", { cwd: resolved.path });
    const shell = await runtime.executeTool(session.id, "shell.command.run", {
      repoRoot: resolved.path,
      command: ["git", "status"],
      dryRun: true
    });
    const output = context.output as { readonly agentsChain?: readonly unknown[]; readonly gitStatus?: string } | undefined;

    results.push({
      label: candidate.label,
      orchestrator: candidate.orchestratorId,
      tier: candidate.tier,
      repo: resolved.displayPath,
      source: resolved.source,
      session: session.status,
      task: session.task?.id ?? null,
      repoContext: context.status,
      shellDryRun: shell.status,
      agents: output?.agentsChain?.length ?? 0,
      gitStatusFirstLine: output?.gitStatus?.split("\n")[0] ?? null,
      signal: candidate.signal,
      signalHits: countSignalHits(resolved.path, candidate.signal)
    });
  }

  console.log(JSON.stringify({ includeRemote, orchestrator: orchestratorFilter ?? null, tier: tierFilter ?? null, orchestratorCount: orchestrators.length, repoCount: results.length, results, skipped }, null, 2));
} finally {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function getFlagValue(flagName: string): string | undefined {
  const index = process.argv.indexOf(flagName);
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  return value && !value.startsWith("--") ? value : undefined;
}

function parseTierFilter(value: string | undefined): DogfoodTier | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "core" || value === "tier-2") {
    return value;
  }

  throw new Error(`Invalid --tier: ${value}. Allowed values: core, tier-2`);
}

function resolveCandidate(candidate: DogfoodRepoCandidate): ResolvedPortfolioRepo | null {
  if (candidate.relativePath) {
    const repoPath = join(home, candidate.relativePath);
    if (existsSync(repoPath)) {
      return { candidate, path: repoPath, displayPath: `<user-home>/${candidate.relativePath}`, source: "local" };
    }
  }

  if (!candidate.remoteUrl || !includeRemote) {
    return null;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "guruharness-portfolio-"));
  tempRoots.push(tempRoot);
  const checkoutPath = join(tempRoot, basename(candidate.remoteUrl, ".git"));
  const cloneArgs = ["clone", "--depth=1", "--single-branch"];

  if (candidate.remoteRef) {
    cloneArgs.push("--branch", candidate.remoteRef);
  }

  cloneArgs.push(candidate.remoteUrl, checkoutPath);

  try {
    execFileSync("git", cloneArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch {
    cloneFailureReasons.set(candidate.label, "remote clone failed");
    return null;
  }

  return { candidate, path: checkoutPath, displayPath: candidate.remoteUrl.replace(/^https:\/\/github\.com\//u, "github:"), source: "remote-temp" };
}

function countSignalHits(repoPath: string, signal: string): number {
  if (signal === "beeper") {
    return countPathHits(repoPath, signal) + countTextHits(repoPath, signal);
  }

  return countTextHits(repoPath, signal);
}

function countTextHits(repoPath: string, signal: string): number {
  try {
    const output = execFileSync("rg", ["-i", "--hidden", "-l", signal, repoPath, "-g", "!.git", "-g", "!node_modules"], {
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    return output.length === 0 ? 0 : output.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function countPathHits(rootPath: string, signal: string): number {
  let hits = 0;
  const stack: Array<{ readonly path: string; readonly depth: number }> = [{ path: rootPath, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 8) {
      continue;
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(current.path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") {
        continue;
      }

      const childPath = join(current.path, entry);
      if (entry.toLowerCase().includes(signal.toLowerCase())) {
        hits += 1;
      }

      stack.push({ path: childPath, depth: current.depth + 1 });
    }
  }

  return hits;
}
