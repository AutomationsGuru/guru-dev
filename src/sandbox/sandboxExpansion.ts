import { resolve } from "node:path";

import {
  type ExpansionDecision,
  type ExpansionNeed,
  ExpansionNeedSchema,
  type ExpansionSession
} from "./sandboxExpansionSchema.js";

/**
 * F97 Sandbox Expansion — pure types and factory.
 *
 * When a sandboxed tool fails for missing path/network rights (or is classified
 * as needing extra mounts), this module surfaces a structured expansion request.
 * On operator approve, it returns a ONE-SHOT expansion scope that applies to
 * exactly one tool call — the expansion is consumed immediately after that call
 * and can never be reused. A second call on a consumed expansion throws.
 *
 * Hard limits from the constitution (§3) are structurally enforced BEFORE
 * expansion paths are granted: destructive patterns, secret-adjacent paths,
 * and auth-ecosystem files are always rejected regardless of the expansion
 * decision. YOLO never lifts this gate.
 */

// ── Denial signal shape (from tool execution / mandate layer) ──────────────

/**
 * A structured denial signal emitted when a tool executor refuses a call.
 * The `kind` categorizes the denial; `detail` carries tool-specific context.
 * This is the **input** to `detectNeed`, not a public API surface.
 */
export interface SandboxDenialSignal {
  readonly kind: "path-outside-sandbox" | "network-denied" | "classifier-flagged";
  readonly detail: string;
  readonly paths?: readonly string[];
}

// ── One-Shot Expansion ────────────────────────────────────────────────────

/**
 * A one-shot expansion scope. The consumer (tool executor) checks the expanded
 * paths and network flag, re-runs the single tool call, then calls `consume()`
 * to invalidate the expansion. A second `consume()` throws — one-shot by
 * construction, not convention.
 */
export interface OneShotExpansion {
  /** Paths granted for this single call (read-only). */
  readonly expandedPaths: ReadonlySet<string>;
  /** Whether network access is granted for this single call. */
  readonly networkAllowed: boolean;
  /** Whether the expansion has been consumed. */
  readonly consumed: boolean;
  /** Consume the expansion — marks it used. Throws if already consumed. */
  consume(): void;
}

// ── Hard-limit path guards (Constitution §3) ──────────────────────────────

/** Paths that match destructive intent — never expandable. */
const DESTRUCTIVE_PATH_PATTERN = /\brm\b|\bdel\b|\bdestroy\b|\bwipe\b|\bformat\b/i;

/** Secret-adjacent file targets (.env, keys, credentials). */
const SECRET_PATH_PATTERN = /(^|[\s/\\])(\.env(\.[\w-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_rsa|id_ed25519|\.npmrc|credentials|\.pgpass|\.htpasswd)($|\s)/i;

/** Ecosystem auth files (cloud/provider CLI token stores). */
const AUTH_PATH_PATTERN = /(\.aws[/\\]credentials|\.config[/\\]gh|\.codex|\.config[/\\]gcloud|\.docker[/\\]config|\.kube[/\\]config|\.netrc|\.ssh[/\\])/i;

/**
 * Reject expansion paths that would violate hard limits. Returns an error
 * string if any path is blocked, or null if all paths are safe to expand.
 */
function validateExpansionPaths(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (DESTRUCTIVE_PATH_PATTERN.test(path)) {
      return `hard-limit: destructive path not expandable (${path})`;
    }
    if (SECRET_PATH_PATTERN.test(path)) {
      return `hard-limit: secret-edge path not expandable (${path})`;
    }
    if (AUTH_PATH_PATTERN.test(path)) {
      return `hard-limit: auth-edge path not expandable (${path})`;
    }
  }
  return null;
}

// ── Detection ─────────────────────────────────────────────────────────────

/**
 * Tool IDs that exercise network access — when denied, surface network flag.
 */
const NETWORK_TOOL_IDS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
  "git.pr.run",
  "github.pr.comment",
  "github.pr.review",
  "honcho_remember",
  "honcho_log_turn"
]);

/**
 * Paths that commonly live outside a workspace sandbox but are safe to expand
 * to (OS-level tooling, system config, mounts). This is a classifier HINT,
 * not an auto-approval — the operator still decides.
 */
const SYSTEM_TOOL_PATHS = new Set(["/usr", "/bin", "/sbin", "/lib", "/tmp", "/dev", "/mnt", "/media", "/opt", "/var", "/etc"]);

/** CWD-escape patterns — shell commands that try to leave the workspace. */
const CWD_ESCAPE_PATTERN = /(?:\.\.[\\/]|^\/[^d]|^[a-zA-Z]:\\)/;

/**
 * Detect an expansion need from a tool call + optional denial signal.
 *
 * When a `denialSignal` is provided (from the tool executor), it carries the
 * richest signal — the exact paths and denial kind. Without a signal, a
 * lightweight classifier inspects the tool call for paths outside the
 * workspace or network-dependent tools that would fail in an isolated sandbox.
 *
 * Returns null when no expansion is appropriate (e.g., the tool is read-only,
 * the denial was not path/network related, or the classified need is empty).
 */
export function detectNeed(
  toolId: string,
  input: unknown,
  denialSignal?: SandboxDenialSignal
): ExpansionNeed | null {
  // Explicit denial signal carries the richest data.
  if (denialSignal) {
    return detectNeedFromDenial(toolId, denialSignal);
  }

  // Passive classifier: inspect tool call for workspace-outside paths.
  return detectNeedFromClassifier(toolId, input);
}

function detectNeedFromDenial(
  toolId: string,
  signal: SandboxDenialSignal
): ExpansionNeed | null {
  const paths = signal.paths ?? [];
  const network = signal.kind === "network-denied" ?? false;

  if (paths.length === 0 && !network) {
    return null;
  }

  const reason = `sandbox denial: ${signal.kind} — ${signal.detail}`;
  const result = ExpansionNeedSchema.safeParse({ paths, network, reason });
  return result.success ? result.data : null;
}

function detectNeedFromClassifier(
  toolId: string,
  input: unknown
): ExpansionNeed | null {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  // Shell commands: check cwd and command paths.
  if (toolId === "bash" || toolId === "shell.command.run") {
    return classifyShellCommand(toolId, record);
  }

  // Network tools in a restricted sandbox would need expansion.
  if (NETWORK_TOOL_IDS.has(toolId)) {
    return {
      paths: [],
      network: true,
      reason: `classifier: ${toolId} requires network access outside baseline sandbox`
    };
  }

  return null;
}

function classifyShellCommand(
  toolId: string,
  record: Record<string, unknown>
): ExpansionNeed | null {
  const needs: string[] = [];
  let network = false;
  const reasons: string[] = [];

  // Check cwd for workspace escape.
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  if (cwd.length > 0 && CWD_ESCAPE_PATTERN.test(cwd)) {
    needs.push(cwd);
    reasons.push(`cwd escapes workspace: ${cwd}`);
  }

  // Check command string for absolute paths outside typical workspace paths.
  const command = String(record.command ?? record.cmd ?? "");
  if (command.length > 0) {
    // Detect absolute paths in the command that start outside the workspace.
    const absPathMatches = command.match(/(?:^|\s)(\/[a-zA-Z0-9_.-][^\s"'<>|]*)/g);
    if (absPathMatches) {
      for (const match of absPathMatches) {
        const trimmed = match.trim();
        if (trimmed.startsWith("/")) {
          // Only flag paths targeting system directories, not relative-looking paths.
          const topDir = trimmed.split("/").slice(0, 3).join("/");
          for (const sysPath of SYSTEM_TOOL_PATHS) {
            if (topDir.startsWith(sysPath)) {
              needs.push(trimmed);
              reasons.push(`command references system path outside workspace: ${trimmed}`);
              break;
            }
          }
        }
      }
    }

    // Detect network clients (curl, wget) — classify as network need.
    if (/\b(curl|wget)\b/i.test(command)) {
      network = true;
      reasons.push("command uses network client (curl/wget)");
    }
  }

  if (needs.length === 0 && !network) {
    return null;
  }

  return {
    paths: needs,
    network,
    reason: `classifier: ${toolId} — ${reasons.join("; ")}`
  };
}

// ── Expansion Application ─────────────────────────────────────────────────

/**
 * Apply a one-shot expansion to a session. Validates hard limits FIRST,
 * then creates a scoped expansion object. Returns the expansion for the
 * caller (tool executor) to consume.
 *
 * Throws if:
 * - The need contains paths that violate hard limits (destructive, secret-edge, auth-edge).
 * - The session already has an unconsumed expansion (one-at-a-time).
 */
export function applyOneShotExpansion(
  session: ExpansionSession,
  decision: ExpansionDecision,
  need: ExpansionNeed
): OneShotExpansion | null {
  if (decision === "deny") {
    return null;
  }

  // Hard-limit gate: validate paths before expanding (Constitution §3).
  const hardLimitError = validateExpansionPaths(need.paths);
  if (hardLimitError) {
    throw new Error(hardLimitError);
  }

  // One-at-a-time: reject stacking expansions.
  if (session.activeExpansion && !session.activeExpansion.consumed) {
    throw new Error("an unconsumed expansion is already active — consume it first");
  }

  let consumed = false;

  const expansion: OneShotExpansion = {
    expandedPaths: new Set(need.paths),
    networkAllowed: need.network,
    consumed: false,
    consume() {
      if (consumed) {
        throw new Error("expansion already consumed — each expansion is one-shot");
      }
      consumed = true;
      // Mutate the session reference so the session reflects consumption.
      if (session.activeExpansion === this) {
        (this as { consumed: boolean }).consumed = true;
      }
    }
  };

  session.activeExpansion = expansion;
  return expansion;
}

// ── Session Factory ───────────────────────────────────────────────────────

/**
 * Create an empty expansion session. The tool executor drains the
 * `activeExpansion` on the next eligible tool call.
 */
export function createExpansionSession(): ExpansionSession {
  return { activeExpansion: null };
}