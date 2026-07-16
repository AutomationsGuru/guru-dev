import { resolve } from "node:path";

import { HARD_EDGE_VERBS, type MandateState, type MandateVerb } from "./schema.js";

/**
 * Maps a tool id + input to the verbs it exercises. Read-only tools imply no
 * gated verb (they are always allowed). Everything else declares what it does so
 * the mandate can reason about it.
 */
const TOOL_VERBS: Readonly<Record<string, readonly MandateVerb[]>> = {
  bash: ["exec"],
  "shell.command.run": ["exec"],
  edit: ["write"],
  write: ["write"],
  "fs.edit.apply": ["write"],
  memory_remember: ["write"],
  memory_forget: ["write"],
  memory_doctor: ["write"],
  "operational.state.write": ["write"],
  "operational.decision.upsert": ["write"],
  "operational.backlog.create": ["write"],
  "operational.implementation.create": ["write"],
  "operational.blocker.record": ["write"],
  "git.pr.run": ["net", "exec"],
  "github.pr.comment": ["net"],
  "github.pr.review": ["net"],
  "review.gates.run": ["exec"],
  honcho_remember: ["write", "net"],
  honcho_log_turn: ["write", "net"],
  // The swarm trio is permission-NEUTRAL: spawning delegates no authority — the
  // WORKER's own approval policy gates every action it takes (read-only scouts
  // physically cannot mutate; "all" workers share the live session policy
  // per-call). Gating spawn itself would double-gate without adding safety.
  spawn_agent: [],
  get_task_output: [],
  kill_task: [],
  // Probe-only (registry lookups + PATH presence): never mutates.
  resolve_capability_gap: [],
  // Session task board — process memory only, never disk secrets.
  todo_write: [],
  todo_list: [],
  // Operator Q&A — no mutation.
  ask_question: [],
  // MCP meta-dispatch: discovery is read-only; dispatch is conservatively write-gated.
  search_tool: [],
  use_tool: ["write"],
  // MCP attach board — read-only snapshot.
  mcp_bridge_status: [],
  // Networked research (bounded).
  web_fetch: ["net"],
  web_search: ["net"],
  // Provider CLI matrix is a PATH/env-name probe only.
  provider_cli_status: [],
  // Live delegated CLI may shell out (and often spend via provider plans).
  provider_cli_run: ["exec"],
  // Desktop: status is probe-only; mutations escalate (live path still needs userApproved).
  pyautogui_status: [],
  pyautogui_screen: [],
  pyautogui_mouse: ["exec"],
  pyautogui_keyboard: ["exec"],
  // Cursor-parity local tools (wave 2026-07-10) — no mutation.
  read_diagnostics: [],
  manage_task: []
};

/** Read-only tools: never gated by the mandate (the always-allowed floor). */
export const MANDATE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "repo.context.resolve",
  "skills.catalog.list",
  "skill.document.load",
  "memory_search",
  "memory_get",
  "memory_status",
  "honcho_memory_status",
  "honcho_recall",
  "honcho_context",
  "todo_list",
  "ask_question",
  "search_tool",
  "mcp_bridge_status",
  "provider_cli_status",
  "pyautogui_status",
  "service_readiness_report",
  "operational.project.get",
  "operational.state.list",
  "operational.backlog.list",
  "github.pr.status",
  "read_diagnostics"
]);

/**
 * Non-rm destructive shell forms. `rm` is handled by {@link isDestructiveRm}
 * so split/long flags (`rm -r -f`, `rm --recursive --force`) escalate the same
 * way as the classic `rm -rf` cluster. Windows recursive deletes are handled by
 * {@link isDestructiveWindowsDelete} (YOLO silent-allow hole on this host).
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // Force-push: --force (not the safer --force-with-lease).
  /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i,
  // Force-push short form: `git push -f` / `git push origin main -f`.
  /\bgit\s+push\b(?:\s+\S+)*?\s+-f(?:\s|$)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(mkfs|dd\s+if=|:\(\)\s*\{)/i,
  /\bshutdown\b|\breboot\b/i
];

/**
 * True when a shell command is a recursive+force `rm` in any common flag shape:
 * `rm -rf`, `rm -fr`, `rm -r -f`, `rm -f -r`, `rm --recursive --force`.
 * Recursive alone (`rm -r`) is NOT destructive-class (no force).
 */
export function isDestructiveRm(command: string): boolean {
  if (!/\brm\b/i.test(command)) {
    return false;
  }
  // Scan tokens after the first `rm` until a non-flag path argument.
  const tokens = command.split(/\s+/u).filter((t) => t.length > 0);
  const rmAt = tokens.findIndex((t) => t.toLowerCase() === "rm");
  if (rmAt < 0) {
    return false;
  }
  let recursive = false;
  let force = false;
  for (let i = rmAt + 1; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--") {
      break;
    }
    if (token.startsWith("--")) {
      const long = token.toLowerCase();
      if (long === "--recursive" || long === "--dir" || long === "--directory") {
        recursive = true;
      } else if (long === "--force") {
        force = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      // Short cluster: -rf / -fr / -R / -f / -rF etc.
      const letters = token.slice(1);
      if (/[rR]/u.test(letters)) {
        recursive = true;
      }
      if (/[fF]/u.test(letters)) {
        force = true;
      }
      continue;
    }
    // First non-flag token is the path/target — stop scanning flags.
    break;
  }
  return recursive && force;
}

/**
 * Windows / PowerShell recursive-delete shapes that must escalate like `rm -rf`.
 * Under YOLO-by-default these were silent-allow (only Unix `rm` was hard-edged),
 * so a model running on this Windows host could wipe trees without a prompt.
 *
 * Covered:
 * - `del /s /q …`, `del /f /s /q …`
 * - `rmdir /s /q …`, `rd /s /q …`
 * - `Remove-Item -Recurse -Force …` (and `-r` / `-fo` short forms)
 * - `ri -r -fo …` (Remove-Item alias)
 */
export function isDestructiveWindowsDelete(command: string): boolean {
  // cmd.exe: del/erase with /S (recurse) — quiet or not, the tree is wiped.
  if (/\b(?:del|erase)\b/i.test(command) && /\/s\b/i.test(command)) {
    return true;
  }
  // cmd.exe: rmdir/rd with /S.
  if (/\b(?:rmdir|rd)\b/i.test(command) && /\/s\b/i.test(command)) {
    return true;
  }
  // PowerShell Remove-Item / ri: recurse + force in any flag shape.
  if (/\b(?:remove-item|ri)\b/i.test(command)) {
    const recurse = /(?:-recurse\b|-r\b)/i.test(command);
    const force = /(?:-force\b|-fo\b)/i.test(command);
    if (recurse && force) {
      return true;
    }
  }
  return false;
}

function isDestructiveCommand(command: string): boolean {
  return (
    isDestructiveRm(command) ||
    isDestructiveWindowsDelete(command) ||
    DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
  );
}

/** Secrets-adjacent file targets (.env, keys, npm auth, credentials). */
// The boundary class includes shell redirects `>` and pipe `|` so `echo x>.env`,
// `echo x>>.env`, and `cmd|tee .env` are detected as secret-edge writes (F5).
const SECRET_PATH_PATTERN = /(^|[\s/\\'"=>|])(\.env(\.[\w-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_rsa|id_ed25519|\.npmrc|credentials|\.pgpass|\.htpasswd)(\b|$)/i;
/** Ecosystem auth files (cloud/provider CLI token + config stores). */
const AUTH_PATH_PATTERN = /(\.aws[/\\]credentials|\.config[/\\]gh|\.codex|\.config[/\\]gcloud|\.docker[/\\]config|\.kube[/\\]config|\.netrc|\.ssh[/\\])/i;
/** A shell command that WRITES (as opposed to merely reading) a path. */
const SHELL_WRITE_INTENT = /(>>?|\btee\b|\bcp\b|\bmv\b|\binstall\b|\bdd\b|\bchmod\b|\bchown\b|\bln\s+-s)/i;

/**
 * Commands that MOVE MONEY or provision BILLABLE resources — the `spend` hard edge
 * (§2.3). High-precision by design: a coding session rarely runs these, so a match
 * is a genuine spend signal, and the safe direction is to prompt. Read-only cloud
 * calls (`aws s3 ls`, `gcloud config set`) deliberately do NOT match — only the
 * provisioning / deploy / payment verbs do.
 */
const SPEND_PATTERNS: readonly RegExp[] = [
  /\bterraform\s+(apply|destroy)\b/i, // provision / tear down billable infra
  /\bpulumi\s+(up|destroy)\b/i,
  /\bfly(ctl)?\s+deploy\b/i, // paid PaaS deploys
  /\brailway\s+up\b/i,
  /\bheroku\s+(create|ps:scale|addons:(create|add))\b/i,
  /\b(vercel|netlify)\b[^\n]*--prod\b/i, // production (billable) deploy
  /\baws\s+[a-z0-9-]+\s+(run-instances|start-instances|create-[a-z-]+|purchase-[a-z-]+)\b/i,
  /\b(gcloud|az)\s+[a-z0-9-]+\s+[a-z0-9 -]*?\bcreate\b/i, // create a cloud resource
  /\bstripe\b[^\n]*\b(charges?|payment_intents?|subscriptions?|invoices?|payouts?)\b/i // payments
];

/**
 * Derives the verbs a specific tool call exercises. Escalates to "destructive" on
 * a destructive shell pattern, "spend" on a money-moving / billable-provisioning
 * command, and "secret-edge"/"auth-edge" when a WRITE targets a secrets-adjacent
 * or ecosystem-auth file (all hard edges — §2.3, prompt in every mode).
 */
export function verbsForCall(toolId: string, input: unknown): readonly MandateVerb[] {
  const base = TOOL_VERBS[toolId] ?? (MANDATE_READ_ONLY_TOOLS.has(toolId) ? [] : ["write"]);
  const verbs = new Set<MandateVerb>(base);
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  if (toolId === "bash" || toolId === "shell.command.run") {
    const command = String(record.command ?? record.cmd ?? "");
    if (isDestructiveCommand(command)) {
      verbs.add("destructive");
    }
    if (SPEND_PATTERNS.some((pattern) => pattern.test(command))) {
      verbs.add("spend");
    }
    if (SHELL_WRITE_INTENT.test(command)) {
      if (SECRET_PATH_PATTERN.test(command)) verbs.add("secret-edge");
      if (AUTH_PATH_PATTERN.test(command)) verbs.add("auth-edge");
    }
  } else if (verbs.has("write")) {
    // A write/edit tool targets a concrete path — the clearest signal.
    const path = String(record.path ?? "");
    if (SECRET_PATH_PATTERN.test(path)) verbs.add("secret-edge");
    if (AUTH_PATH_PATTERN.test(path)) verbs.add("auth-edge");
  }
  return [...verbs];
}

export type MandateOutcome = "allow" | "deny" | "escalate";

export interface MandateDecision {
  readonly outcome: MandateOutcome;
  readonly reason: string;
  /** The verbs the call was evaluated against (for surfacing). */
  readonly verbs: readonly MandateVerb[];
}

export interface MandateContext {
  readonly cwd: string;
  readonly state: MandateState;
  /** True when the operator has declared YOLO for the session. */
  readonly yolo: boolean;
}

function pathCovers(grantPath: string, target: string): boolean {
  const g = resolve(grantPath);
  const t = resolve(target);
  return t === g || t.startsWith(`${g}/`) || t.startsWith(`${g}\\`);
}

/**
 * Resolve the path a call actually touches for SPACE scoping. Prefer an explicit
 * tool path (write/edit); fall back to cwd for shell/exec (cwd-relative ops).
 * Without this, a SPACE grant was checked only against cwd — a write to an
 * absolute path outside the grant still passed while the operator sat inside
 * the granted tree (critic B13).
 */
export function resolveMandateTargetPath(toolId: string, input: unknown, cwd: string): string {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const raw =
    typeof record.path === "string" && record.path.length > 0
      ? record.path
      : typeof record.file === "string" && record.file.length > 0
        ? record.file
        : typeof record.file_path === "string" && record.file_path.length > 0
          ? record.file_path
          : "";
  if (raw.length > 0 && (toolId === "write" || toolId === "edit" || toolId === "fs.edit.apply" || toolId === "read" || toolId === "bash" || toolId === "shell.command.run")) {
    // Absolute targets resolve as-is; relative ones resolve under cwd.
    return resolve(cwd, raw);
  }

  if (toolId === "bash" || toolId === "shell.command.run") {
    const command = String(record.command ?? record.cmd ?? "");
    // Bash-under-SPACE escape via absolute/relative paths in shell string.
    // If the shell command names a path outside cwd (absolute or ../), treat it as the target.
    // (Excludes /dev/null and nul).
    const escapeMatch = command.match(/(?:^|[\s'"=|>])([a-zA-Z]:[\\/][^\s"'<>|]+|\/[^\s"'<>|]+|(?:\.\.[\\/])+[^\s"'<>|]*)/);
    if (escapeMatch && escapeMatch[1]) {
      const p = escapeMatch[1];
      if (p !== "/dev/null" && p.toLowerCase() !== "nul") {
        return resolve(cwd, p);
      }
    }
  }

  return resolve(cwd);
}

/**
 * Evaluates a tool call against the mandate. Order (THERE §2.3 Article 3):
 * read-only floor → deny-wins → HARD-EDGE escalation → YOLO → covering grant →
 * escalate. Deny and hard edges are evaluated BEFORE YOLO, so YOLO lifts
 * ordinary permission gates but NEVER a deny or a hard edge (destructive / spend
 * / secrets-adjacent-write / ecosystem-auth-file) — those still escalate in
 * every mode including YOLO.
 */
export function evaluateToolMandate(toolId: string, input: unknown, ctx: MandateContext): MandateDecision {
  const verbs = verbsForCall(toolId, input);
  const targetPath = resolveMandateTargetPath(toolId, input, ctx.cwd);

  if (verbs.length === 0) {
    return { outcome: "allow", reason: "read-only tool (always allowed)", verbs };
  }

  // Deny-wins — beats a grant AND beats YOLO.
  for (const deny of ctx.state.denies) {
    if (verbs.includes(deny.verb) && (!deny.path || pathCovers(deny.path, targetPath))) {
      return { outcome: "deny", reason: `denied by rule (${deny.verb}${deny.path ? ` in ${deny.path}` : ""})`, verbs };
    }
  }

  // Hard edges are never covered by a standing grant AND never lifted by YOLO
  // (Article 3): they escalate in every mode. The real per-call prompt is a
  // composer gap; escalate routes to the interactive/allow-writes fallthrough.
  const hardEdge = verbs.find((verb) => HARD_EDGE_VERBS.has(verb));
  if (hardEdge) {
    return { outcome: "escalate", reason: `hard edge (${hardEdge}) requires explicit confirmation in every mode — even YOLO`, verbs };
  }

  // YOLO lifts every ordinary PERMISSION gate (the self-mutation constitution +
  // secret output law live elsewhere and are unaffected).
  if (ctx.yolo) {
    return { outcome: "allow", reason: "YOLO mode: ordinary permission gates lifted (hard edges/denies still bind)", verbs };
  }

  // A covering grant that carries every required verb allows the call.
  // SPACE scope is checked against the operation TARGET, not only cwd.
  for (const grant of ctx.state.grants) {
    const inScope =
      grant.scope === "machine" || (grant.scope === "space" && grant.path !== undefined && pathCovers(grant.path, targetPath));
    if (inScope && verbs.every((verb) => grant.verbs.includes(verb))) {
      return { outcome: "allow", reason: `granted by ${grant.scope}${grant.scope === "space" ? ` (${grant.path})` : ""} mandate`, verbs };
    }
  }

  return { outcome: "escalate", reason: `no mandate covers ${verbs.join("+")} — falls through to interactive approval`, verbs };
}
