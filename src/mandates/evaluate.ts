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
  // Networked research (bounded).
  web_fetch: ["net"],
  web_search: ["net"],
  // Provider CLI matrix is a PATH/env-name probe only.
  provider_cli_status: [],
  // Live delegated CLI may shell out (and often spend via provider plans).
  provider_cli_run: ["exec"]
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
  "honcho_memory_status",
  "honcho_recall",
  "honcho_context",
  "todo_list",
  "ask_question",
  "provider_cli_status",
  "service_readiness_report",
  "operational.project.get",
  "operational.state.list",
  "operational.backlog.list",
  "github.pr.status"
]);

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, // rm -rf / -fr
  /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i, // force push (not --force-with-lease)
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(mkfs|dd\s+if=|:\(\)\s*\{)/i,
  /\bshutdown\b|\breboot\b/i
];

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
    if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
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

function pathCovers(grantPath: string, cwd: string): boolean {
  const g = resolve(grantPath);
  const c = resolve(cwd);
  return c === g || c.startsWith(`${g}/`) || c.startsWith(`${g}\\`);
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

  if (verbs.length === 0) {
    return { outcome: "allow", reason: "read-only tool (always allowed)", verbs };
  }

  // Deny-wins — beats a grant AND beats YOLO.
  for (const deny of ctx.state.denies) {
    if (verbs.includes(deny.verb) && (!deny.path || pathCovers(deny.path, ctx.cwd))) {
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
  for (const grant of ctx.state.grants) {
    const inScope = grant.scope === "machine" || (grant.scope === "space" && grant.path && pathCovers(grant.path, ctx.cwd));
    if (inScope && verbs.every((verb) => grant.verbs.includes(verb))) {
      return { outcome: "allow", reason: `granted by ${grant.scope}${grant.scope === "space" ? ` (${grant.path})` : ""} mandate`, verbs };
    }
  }

  return { outcome: "escalate", reason: `no mandate covers ${verbs.join("+")} — falls through to interactive approval`, verbs };
}
