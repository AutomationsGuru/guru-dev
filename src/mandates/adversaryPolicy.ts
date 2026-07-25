import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { HARD_EDGE_VERBS, type MandateVerb } from "./schema.js";

/**
 * Adversary policy — the operator-authored markdown file that arms the optional
 * pre-tool adversary gate (`adversaryGate.ts`). Policy is POLICY, not secret: it
 * lives under the home profile as `~/.guruharness/adversary.md`, with an optional
 * per-project overlay at `<project>/.guru/adversary.md`.
 *
 * Overlay semantics are TIGHTEN-ONLY (IDEA-F2): a project overlay may add review
 * scope (extra tools) or force fail-closed behavior, but it can never remove a
 * hard-limit verb, narrow the home tool list, or re-enable a disabled gate. The
 * gate is subordinate to the structural mandate floor either way — an adversary
 * ALLOW never lifts a mandate deny or hard edge downstream.
 */

/** High-risk tool ids reviewed by default when the policy file names no tools. */
export const DEFAULT_ADVERSARY_REVIEWED_TOOLS: readonly string[] = ["bash", "shell.command.run", "write", "edit", "fs.edit.apply"];

/** Risk class a call falls into. `hard-limit` calls ALWAYS fail closed on error. */
export type AdversaryRiskClass = "hard-limit" | "unknown" | "standard";

/**
 * Maps the verbs a call exercises to its adversary risk class. Any hard-edge verb
 * (destructive / spend / secret-edge / auth-edge) is `hard-limit`; any other
 * gated verb is `unknown` (not provably read-only); a verb-free call is
 * `standard`. Unknown is intentionally stricter than "probably fine": a risk we
 * cannot classify is never allowed to fail open.
 */
export function riskClassForVerbs(verbs: readonly MandateVerb[]): AdversaryRiskClass {
  if (verbs.some((verb) => HARD_EDGE_VERBS.has(verb))) {
    return "hard-limit";
  }
  if (verbs.length > 0) {
    return "unknown";
  }
  return "standard";
}

/** Body verbs of a nonempty policy markdown = the gate is enabled. */
export function isAdversaryPolicyEnabled(body: string): boolean {
  return body.trim().length > 0;
}

/** Tool ids a policy covers: header `tools:`/`review:` line, else the defaults. */
export function adversaryReviewedTools(body: string): readonly string[] {
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(?:tools|review)\s*:\s*(.+)$/iu);
    if (match?.[1]) {
      const tools = match[1]
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      if (tools.length > 0) {
        return tools;
      }
    }
  }
  return DEFAULT_ADVERSARY_REVIEWED_TOOLS;
}

/** Policy header `fail_open: true|yes|on` opts SOFT classes into fail-open. */
export function adversaryPolicyAllowsFailOpen(body: string): boolean {
  return /^\s*fail[_-]?open\s*:\s*(?:true|yes|on)\s*$/gimu.test(body);
}

/** Resolved, merged policy for one workspace. Pure data — no I/O beyond load. */
export interface AdversaryPolicy {
  /** False when no policy file exists or every source is empty → gate disabled. */
  readonly enabled: boolean;
  /** Merged reviewed-tool list (home ∪ project). */
  readonly reviewedTools: readonly string[];
  /** Home markdown body (for prompt assembly). */
  readonly homeBody: string;
  /** Project overlay markdown body (appended; tighten-only). */
  readonly overlayBody: string;
  /** True when a source opted soft classes into fail-open. */
  readonly failOpenSoft: boolean;
  /** Absolute paths that contributed policy text (surfacing/diagnostics). */
  readonly sources: readonly string[];
}

export interface AdversaryPolicyPaths {
  /** Home policy path; defaults to ~/.guruharness/adversary.md. */
  readonly homePolicyPath?: string;
  /** Project overlay path; defaults to <cwd>/.guru/adversary.md. */
  readonly projectPolicyPath?: string;
}

export interface LoadAdversaryPolicyOptions extends AdversaryPolicyPaths {
  readonly cwd?: string;
  /** Test seam for the home directory; defaults to the operator's $HOME. */
  readonly homeDirectory?: string;
}

/** Default home policy location — matches the mandate-store home convention. */
export function defaultAdversaryPolicyPath(homeDirectory?: string): string {
  return resolve(join(homeDirectory ?? homedir(), ".guruharness", "adversary.md"));
}

function readPolicyBody(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    return readFileSync(filePath, "utf8");
  } catch {
    // An unreadable policy contributes nothing; the gate stays disabled unless
    // another source arms it. Never throws open, never throws at all.
    return undefined;
  }
}

/**
 * Loads and merges the home policy plus the optional project overlay. Merge
 * rules are tighten-only:
 *
 * - reviewedTools = union (overlay may ADD scope, never remove it);
 * - enabled = any source has body text (an overlay cannot disable a home policy);
 * - failOpenSoft = any source opts in (soft classes only — hard-limit and
 *   unknown risk classes are structurally fail-closed regardless, enforced in
 *   adversaryGate, not here).
 */
export function loadAdversaryPolicy(options: LoadAdversaryPolicyOptions = {}): AdversaryPolicy {
  const homePath = options.homePolicyPath ?? defaultAdversaryPolicyPath(options.homeDirectory);
  const projectPath = options.projectPolicyPath ?? resolve(join(options.cwd ?? process.cwd(), ".guru", "adversary.md"));

  const homeBody = readPolicyBody(homePath);
  const overlayBody = readPolicyBody(projectPath);

  const sources: string[] = [];
  if (homeBody !== undefined) sources.push(homePath);
  if (overlayBody !== undefined) sources.push(projectPath);

  const bodies = [homeBody, overlayBody].filter((body): body is string => body !== undefined);
  // Only bodies with real content arm the gate, contribute scope, or set headers —
  // an empty/whitespace file must not inject the default tool list.
  const activeBodies = bodies.filter(isAdversaryPolicyEnabled);
  const enabled = activeBodies.length > 0;
  const failOpenSoft = activeBodies.some(adversaryPolicyAllowsFailOpen);

  const reviewed = new Set<string>();
  for (const body of activeBodies) {
    for (const tool of adversaryReviewedTools(body)) {
      reviewed.add(tool);
    }
  }

  return {
    enabled,
    reviewedTools: [...reviewed],
    homeBody: homeBody ?? "",
    overlayBody: overlayBody ?? "",
    failOpenSoft,
    sources
  };
}
