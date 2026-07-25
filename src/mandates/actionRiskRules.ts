import { relative, resolve } from "node:path";

import { z } from "zod";

/** Static levels used to route a tool call before execution. */
export const RiskLevelSchema = z.enum(["low", "medium", "high", "hard-limit"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export interface RiskReason {
  readonly category: string;
  readonly description: string;
}

export interface ActionRisk {
  readonly level: RiskLevel;
  readonly reasons: readonly RiskReason[];
}

type ToolArgs = Readonly<Record<string, unknown>>;

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
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
  "read_diagnostics",
  "monitor",
  "lsp"
]);

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "fs.edit.apply"]);
const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
  "github.pr.run",
  "github.pr.comment",
  "github.pr.review",
  "github.pr.status"
]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell.command.run"]);

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\b[^\n]*-\w*[rf]\w*/i,
  /\brm\b[^\n]*--recursive[^\n]*--force/i,
  /\b(?:rmdir|rd)\b[^\n]*\/s/i,
  /\b(?:del|erase)\b[^\n]*\/s/i,
  /\b(?:Remove-Item|ri)\b(?=[^\n]*-Recurse|[^\n]*-r\b)(?=[^\n]*-Force|[^\n]*-fo\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i,
  /\bgit\s+push\b[^\n]*\s-f(?:\s|$)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b|\breboot\b/i,
  /\b:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};/i
];

const REMOTE_EXEC_PATTERN = /\b(?:curl|wget)\b[^|\n]*\|[^\n]*\b(?:sh|bash|zsh|fish|python(?:3)?|ruby|perl|node|php)\b/i;
const NETWORK_CLIENT_PATTERN = /\b(?:curl|wget|nc|netcat|nmap)\b/i;
const SPEND_PATTERNS: readonly RegExp[] = [
  /\bterraform\s+(?:apply|destroy)\b/i,
  /\bpulumi\s+(?:up|destroy)\b/i,
  /\bfly(?:ctl)?\s+deploy\b/i,
  /\brailway\s+up\b/i,
  /\bheroku\s+(?:create|ps:scale|addons:(?:create|add))\b/i,
  /\b(?:vercel|netlify)\b[^\n]*--prod\b/i,
  /\baws\s+[a-z0-9-]+\s+(?:run-instances|start-instances|create-[a-z-]+|purchase-[a-z-]+)\b/i,
  /\b(?:gcloud|az)\s+[a-z0-9-]+\s+[a-z0-9 -]*?\bcreate\b/i,
  /\bstripe\b[^\n]*\b(?:charges?|payment_intents?|subscriptions?|invoices?|payouts?)\b/i
];

const SECRET_PATH_PATTERN = /(^|[\s/\\'"=>|])(\.env(?:\.[\w-]+)?|[\w.-]*\.pem|[\w.-]*\.key|id_rsa|id_ed25519|\.npmrc|credentials|\.pgpass|\.htpasswd)(\b|$)/i;
const AUTH_PATH_PATTERN = /(\.aws[/\\]credentials|\.config[/\\]gh|\.codex|\.config[/\\]gcloud|\.docker[/\\]config|\.kube[/\\]config|\.netrc|\.ssh[/\\])/i;
const SHELL_WRITE_INTENT = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\binstall\b|\bdd\b|\bchmod\b|\bchown\b)/i;

function asRecord(args: unknown): ToolArgs {
  return typeof args === "object" && args !== null ? (args as ToolArgs) : {};
}

function stringArg(record: ToolArgs, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function hasDestructiveRm(command: string): boolean {
  const tokens = command.split(/\s+/u);
  const index = tokens.findIndex((token) => token.toLowerCase() === "rm");
  if (index < 0) return false;

  let recursive = false;
  let force = false;
  for (const token of tokens.slice(index + 1)) {
    if (token === "--") break;
    if (token === "--recursive") recursive = true;
    else if (token === "--force") force = true;
    else if (token.startsWith("-") && token.length > 1) {
      const flags = token.slice(1);
      recursive ||= /[rR]/u.test(flags);
      force ||= /[fF]/u.test(flags);
    } else {
      break;
    }
  }
  return recursive && force;
}

function targetIsOutsideRoot(path: string, root: string): boolean {
  const target = resolve(root, path);
  const fromRoot = relative(resolve(root), target);
  return fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function classifyWrite(path: string, root: string | undefined, reasons: RiskReason[]): void {
  if (SECRET_PATH_PATTERN.test(path)) {
    reasons.push({ category: "secrets-write", description: "write target is secrets-adjacent" });
  }
  if (AUTH_PATH_PATTERN.test(path)) {
    reasons.push({ category: "auth-write", description: "write target is an ecosystem-auth path" });
  }
  if (root !== undefined && targetIsOutsideRoot(path, root)) {
    reasons.push({ category: "outside-root-write", description: "write target resolves outside the declared workspace root" });
  }
}

/**
 * Classify a proposed tool call without executing it.
 *
 * A `root`, `workspaceRoot`, or `cwd` argument lets write calls establish whether
 * their target escapes the workspace. Hard-limit results are intended for a
 * structural deny path; high results require the caller's mandate/approval path.
 */
export function analyzeActionRisk(toolId: string, args: unknown): ActionRisk {
  const record = asRecord(args);
  const reasons: RiskReason[] = [];

  if (READ_ONLY_TOOLS.has(toolId)) {
    return { level: "low", reasons: [{ category: "read-only", description: "tool is read-only" }] };
  }

  if (WRITE_TOOLS.has(toolId)) {
    const path = stringArg(record, "path", "file", "file_path");
    if (path === undefined) {
      reasons.push({ category: "write-target-unknown", description: "write tool has no analyzable target path" });
    } else {
      classifyWrite(path, stringArg(record, "workspaceRoot", "root", "cwd"), reasons);
    }
  }

  if (SHELL_TOOLS.has(toolId)) {
    const command = stringArg(record, "command", "cmd");
    if (command === undefined) {
      reasons.push({ category: "exec-input-unknown", description: "shell tool has no analyzable command" });
    } else {
      if (hasDestructiveRm(command) || DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
        reasons.push({ category: "destructive", description: "command matches a destructive pattern" });
      }
      if (REMOTE_EXEC_PATTERN.test(command)) {
        reasons.push({ category: "remote-exec", description: "command fetches remote code and pipes it into an interpreter" });
      }
      if (NETWORK_CLIENT_PATTERN.test(command)) {
        reasons.push({ category: "network-client", description: "command uses a network client" });
      }
      if (SPEND_PATTERNS.some((pattern) => pattern.test(command))) {
        reasons.push({ category: "spend", description: "command can provision billable resources or move money" });
      }
      if (SHELL_WRITE_INTENT.test(command)) {
        classifyWrite(command, undefined, reasons);
      }
    }
    reasons.push({ category: "exec", description: "shell execution can have arbitrary side effects" });
  }

  if (NETWORK_TOOLS.has(toolId)) {
    reasons.push({ category: "network", description: "tool performs network operations" });
  }

  if (reasons.some((reason) => ["destructive", "remote-exec", "spend", "secrets-write", "auth-write", "outside-root-write"].includes(reason.category))) {
    return { level: "hard-limit", reasons };
  }
  if (reasons.some((reason) => ["exec", "remote-exec", "network-client", "network", "write-target-unknown"].includes(reason.category))) {
    return { level: "high", reasons };
  }
  if (WRITE_TOOLS.has(toolId)) {
    return { level: "medium", reasons: [{ category: "ordinary-write", description: "write target is within ordinary scope" }] };
  }

  return { level: "high", reasons: [{ category: "unknown-tool", description: "unrecognized tool is not classified as safe" }] };
}
