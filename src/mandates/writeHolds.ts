import { resolve } from "node:path";

import type { WriteHoldRule } from "../config/projectLaw.js";

import type { MandateDecision } from "./evaluate.js";
import { HARD_EDGE_VERBS } from "./schema.js";

/**
 * Write-hold enforcement — the mechanical arm of project law (IDEA-B1,
 * R-CW-HOLD). Repo (and optional home) path-glob holds bind a write/edit/
 * apply_patch call EVEN UNDER YOLO / full approval:
 *
 *   - `block` → the call is DENIED outright, in every mode;
 *   - `ask`   → the call ESCALATES to an operator prompt, even when YOLO or a
 *               standing grant would otherwise pass it silently.
 *
 * TIGHTEN-ONLY, by construction. A hold can only move a decision toward more
 * friction (allow → escalate → deny), never less:
 *
 *   - an existing `deny` is returned untouched (deny-wins is preserved);
 *   - an existing hard-edge `escalate` (destructive / spend / secret-edge /
 *     auth-edge) is returned untouched — a hold never widens, redirects, or
 *     replaces a hard edge, it only adds an independent reason to hold;
 *   - a hold never grants authority and never lifts any existing gate.
 *
 * The result is an AUDITED decision: every applied hold produces a structured
 * audit record carrying the invariant hold text and the matched path. Holds
 * carry PATHS ONLY — never file contents — so the audit trail records where a
 * write was held, never a secret value (Constitution §3.3: presence/name, not
 * value).
 *
 * Scope note (v1): holds bind the path-targeted write tools (`write`, `edit`,
 * `fs.edit.apply`). SHELL-MEDIATED writes (`bash` redirect/`tee`/`cp` into a
 * held path) are OUT OF SCOPE for v1 — the shell target is not statically
 * resolvable without executing it, and guessing would be a false-confidence
 * hole. That gap is documented, not silent.
 */

/** Tools whose concrete target path a hold can bind (v1 scope). */
const WRITE_HOLD_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "fs.edit.apply"]);

/** An audit record for one hold that fired on a call. Paths + text only. */
export interface WriteHoldAudit {
  /** The matched hold rule's invariant operator-facing text (verbatim). */
  readonly text: string;
  /** The resolved absolute target path the write was held on. */
  readonly path: string;
  /** The specific glob inside the rule that matched. */
  readonly pattern: string;
  readonly action: "ask" | "block";
  readonly toolId: string;
}

/** The outcome of evaluating holds against one call. */
export interface WriteHoldVerdict {
  /** The hold that governs, when one matched (first `block` wins, else first `ask`). */
  readonly hold: WriteHoldRule | undefined;
  /** The pattern within the governing hold that matched the target. */
  readonly pattern: string | undefined;
  /** The resolved absolute target path that was evaluated. */
  readonly targetPath: string;
  readonly audits: readonly WriteHoldAudit[];
}

/**
 * Resolves the concrete target path a write/edit/apply_patch call touches.
 * Returns null when the tool is out of hold scope or names no path (a hold
 * cannot bind what it cannot locate — it never guesses).
 */
export function resolveWriteHoldTarget(toolId: string, input: unknown, cwd: string): string | null {
  if (!WRITE_HOLD_TOOLS.has(toolId)) {
    return null;
  }
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const raw =
    typeof record.path === "string" && record.path.length > 0
      ? record.path
      : typeof record.file === "string" && record.file.length > 0
        ? record.file
        : typeof record.file_path === "string" && record.file_path.length > 0
          ? record.file_path
          : "";
  if (raw.length === 0) {
    return null;
  }
  return resolve(cwd, raw);
}

/**
 * Matches one hold rule against a resolved absolute target path. Returns the
 * first matching glob pattern, or undefined. Globs may be repo-relative
 * (matched against the path relative to the law's root) or absolute.
 *
 * The matcher is anchored and segment-aware: `*` does not cross a path
 * separator, `**` crosses any depth, `?` matches one non-separator char.
 * There is no substring matching, so a broad pattern cannot accidentally hold
 * an unrelated sibling that merely shares a prefix.
 */
export function matchWriteHold(rule: WriteHoldRule, targetPath: string, root: string): string | undefined {
  const normalizedTarget = normalizeSlashes(targetPath);
  const relativeTarget = relativeWithin(normalizeSlashes(resolve(root)), normalizedTarget);

  for (const pattern of rule.paths) {
    const normalizedPattern = normalizeSlashes(pattern);
    if (isAbsoluteGlob(normalizedPattern)) {
      if (globMatches(normalizedPattern, normalizedTarget)) {
        return pattern;
      }
    } else if (relativeTarget !== null && globMatches(normalizedPattern, relativeTarget)) {
      return pattern;
    }
  }
  return undefined;
}

/**
 * Evaluates every hold against a write call and reports the governing hold.
 * `block` beats `ask` (a denied write must not be downgraded to a prompt).
 * Returns the matched-hold audits for every rule that fired, so the decision
 * is fully explained.
 */
export function evaluateWriteHold(
  toolId: string,
  input: unknown,
  cwd: string,
  holds: readonly WriteHoldRule[],
  root: string = cwd
): WriteHoldVerdict | null {
  const targetPath = resolveWriteHoldTarget(toolId, input, cwd);
  if (targetPath === null || holds.length === 0) {
    return null;
  }

  const audits: WriteHoldAudit[] = [];
  let blockHold: { rule: WriteHoldRule; pattern: string } | undefined;
  let askHold: { rule: WriteHoldRule; pattern: string } | undefined;

  for (const rule of holds) {
    const pattern = matchWriteHold(rule, targetPath, root);
    if (pattern === undefined) {
      continue;
    }
    audits.push({ text: rule.text, path: targetPath, pattern, action: rule.action, toolId });
    if (rule.action === "block" && blockHold === undefined) {
      blockHold = { rule, pattern };
    } else if (rule.action === "ask" && askHold === undefined) {
      askHold = { rule, pattern };
    }
  }

  const governing = blockHold ?? askHold;
  if (governing === undefined) {
    return null;
  }
  return { hold: governing.rule, pattern: governing.pattern, targetPath, audits };
}

/**
 * Applies project-law write holds to a mandate decision — TIGHTEN-ONLY.
 *
 * Strictness lattice: allow < escalate(ask) < escalate(hard edge) < deny. A
 * hold only ever moves a decision UP that lattice, never down:
 *
 *   - `deny` stays `deny` (untouched; deny-wins is never weakened).
 *   - a matching `block` → `deny`, even over a hard-edge escalate (deny is
 *     strictly stronger — the operator cannot approve through a block).
 *   - a matching `ask` → `escalate` over `allow`/grant/YOLO, but NEVER over a
 *     hard-edge escalate: an ask must not strip the hard-edge verbs, or the
 *     downstream approval path would offer a session "always" and stop
 *     re-prompting on a destructive/spend/secret/auth op.
 *
 * This transform is the single choke point shared by the TUI main turn, swarm
 * workers, and the AgentSession engine, so a hold binds identically on every
 * approval path — including under YOLO, whose silent `allow` is exactly what
 * `ask`/`block` are designed to interrupt.
 */
export function applyWriteHolds(
  decision: MandateDecision,
  toolId: string,
  input: unknown,
  ctx: { cwd: string; root?: string },
  holds: readonly WriteHoldRule[]
): MandateDecision {
  // Never weaken an existing deny (deny-wins is absolute).
  if (decision.outcome === "deny") {
    return decision;
  }

  const verdict = evaluateWriteHold(toolId, input, ctx.cwd, holds, ctx.root ?? ctx.cwd);
  if (verdict === null || verdict.hold === undefined) {
    return decision;
  }

  const hardEdge = decision.verbs.some((verb) => HARD_EDGE_VERBS.has(verb));

  if (verdict.hold.action === "block") {
    // Deny is the strongest outcome — a block tightens even a hard-edge prompt
    // into an outright refusal. Hard-edge verbs are preserved for surfacing.
    return {
      outcome: "deny",
      reason: `write hold (block) — ${verdict.hold.text} [${verdict.pattern}]`,
      verbs: decision.verbs
    };
  }

  // action === "ask": force a prompt even under YOLO / a covering grant — but
  // never REPLACE a hard edge, whose always-prompt verbs must survive intact.
  if (hardEdge) {
    return decision;
  }
  return {
    outcome: "escalate",
    reason: `write hold (ask) — ${verdict.hold.text} [${verdict.pattern}] — operator confirmation required in every mode, even YOLO`,
    verbs: decision.verbs
  };
}

// --- glob plumbing (self-contained; no new dependency) ---

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

/** True when a glob is absolute (`/…` or a Windows drive `C:/…`). */
function isAbsoluteGlob(pattern: string): boolean {
  return pattern.startsWith("/") || /^[a-zA-Z]:\//u.test(pattern);
}

/**
 * Returns `target` relative to `root` when target is inside root, else null.
 * Segment-boundary aware so `/work/repo2` is not "inside" `/work/repo`.
 */
function relativeWithin(root: string, target: string): string | null {
  if (target === root) {
    return "";
  }
  const prefix = `${root}/`;
  if (target.startsWith(prefix)) {
    return target.slice(prefix.length);
  }
  return null;
}

/**
 * Compiles a glob into an anchored RegExp. `**` crosses separators, `*` does
 * not, `?` matches one non-separator. All other regex metacharacters are
 * escaped, so a literal path can never act as a pattern.
 */
function globMatches(pattern: string, value: string): boolean {
  return toGlobRegExp(pattern).test(value);
}

function toGlobRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**` — collapse a following `/` so `a/**` also matches `a` itself.
        const slashesAll = pattern[index + 2] === "/";
        source += slashesAll ? "(?:.*)?" : ".*";
        index += slashesAll ? 3 : 2;
      } else {
        source += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += escapeRegExpChar(char);
    index += 1;
  }
  source += "$";
  return new RegExp(source, "u");
}

function escapeRegExpChar(char: string): string {
  return /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
}
