import { z } from "zod";

/**
 * Risk classes used by the autonomy gate. `off` is the read-only floor;
 * `hard-limit` is deliberately outside the selectable autonomy ladder and can
 * never be auto-run by any level.
 */
export const CommandRiskClassSchema = z.enum(["off", "low", "medium", "high", "hard-limit"]);
export type CommandRiskClass = z.infer<typeof CommandRiskClassSchema>;

/** The selectable levels, in increasing order of autonomous authority. */
export const COMMAND_RISK_ORDER: Readonly<Record<CommandRiskClass, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  "hard-limit": Number.POSITIVE_INFINITY
};

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "stat",
  "repo.context.resolve",
  "memory_search",
  "memory_get",
  "memory_status",
  "todo_list",
  "ask_question",
  "provider_cli_status",
  "mcp_bridge_status",
  "read_diagnostics",
  "monitor",
  "lsp",
  "github.pr.status"
]);

const LOW_RISK_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "fs.edit.apply",
  "memory_remember",
  "todo_write"
]);

const HIGH_RISK_TOOL_PATTERN = /(?:push|publish|release|deploy|provision|payment|charge|billing|pr\b|pull-request)/iu;
const SHELL_TOOL_PATTERN = /^(?:bash|shell|shell\.command\.run|exec|execute|command|run)$/iu;
const NETWORK_TOOL_PATTERN = /(?:web_fetch|web_search|http|network|request|mcp\.)/iu;
const HARD_LIMIT_TOOL_PATTERN = /(?:hard[-_ ]?limit|destructive|spend|secret[-_ ]?edge|auth[-_ ]?edge|force[-_ ]?push)/iu;

const SAFE_COMMAND_PATTERN = /^(?:(?:command\s+)?(?:cat|cut|diff|file|find|git\s+(?:branch|diff|log|show|status)|grep|head|ls|pwd|sed|stat|tail|type|where|which)\b)/iu;
const PUSH_COMMAND_PATTERN = /(?:\bgit\s+push\b|\bgh\s+pr\b|\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b|\bvercel\s+deploy\b|\bnetlify\s+deploy\b)/iu;
const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\b(?=[^\n]*\s-[^\n]*[rf])(?=[^\n]*\s-[^\n]*r)(?=[^\n]*\s-[^\n]*f)/iu,
  /\brm\b[^\n]*(?:--recursive[^\n]*--force|--force[^\n]*--recursive)/iu,
  /\b(?:del|erase|rmdir|rd)\b[^\n]*\/s\b/iu,
  /\b(?:remove-item|ri)\b[^\n]*(?:-recurse\b|-r\b)[^\n]*(?:-force\b|-fo\b)/iu,
  /\bgit\s+reset\s+--hard\b/iu,
  /\bgit\s+clean\s+-[^\n]*f/iu,
  /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|\s-f(?:\s|$))/iu,
  /\b(?:mkfs|shutdown|reboot)\b/iu,
  /:\(\)\s*\{\s*:/u
];
const SPEND_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bterraform\s+(?:apply|destroy)\b/iu,
  /\bpulumi\s+(?:up|destroy)\b/iu,
  /\b(?:fly|flyctl)\s+deploy\b/iu,
  /\brailway\s+up\b/iu,
  /\bheroku\s+(?:create|ps:scale|addons:(?:create|add))\b/iu,
  /\b(?:vercel|netlify)\b[^\n]*--prod\b/iu,
  /\b(?:aws|gcloud|az)\s+[^\n]*\b(?:create|run-instances|start-instances|purchase-[a-z-]+)\b/iu,
  /\bstripe\b[^\n]*\b(?:charges?|payment_intents?|subscriptions?|invoices?|payouts?)\b/iu
];
const SECRET_OR_AUTH_PATH_PATTERN = /(?:\.env(?:\.[\w-]+)?|[\w.-]*\.(?:pem|key)|id_(?:rsa|ed25519)|\.npmrc|\.pgpass|\.htpasswd|(?:\.aws[/\\]credentials|\.config[/\\](?:gh|gcloud)|\.codex|\.docker[/\\]config|\.kube[/\\]config|\.netrc|\.ssh[/\\]))/iu;
const SECRET_OR_AUTH_WRITE_PATTERN = /(?:>>?\s*|\b(?:tee|cp|mv|install|chmod|chown)\b[^\n]*\s)(?:[^\n]*)(?:\.env(?:\.[\w-]+)?|[\w.-]*\.(?:pem|key)|id_(?:rsa|ed25519)|\.npmrc|\.pgpass|\.htpasswd|(?:\.aws[/\\]credentials|\.config[/\\](?:gh|gcloud)|\.codex|\.docker[/\\]config|\.kube[/\\]config|\.netrc|\.ssh[/\\]))/iu;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function isHardLimitCommand(command: string): boolean {
  return (
    DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command)) ||
    SPEND_COMMAND_PATTERNS.some((pattern) => pattern.test(command)) ||
    SECRET_OR_AUTH_WRITE_PATTERN.test(command)
  );
}

/**
 * Classify a tool or command without executing it.
 *
 * Unknown tools and arbitrary shell execution are conservative `high` risk,
 * while explicit constitutional hard edges are `hard-limit`. A command hint is
 * optional so callers can classify a tool before they have concrete arguments.
 */
export function classifyCommandRisk(toolName: string, commandHint?: string): CommandRiskClass {
  const tool = normalize(toolName);
  const command = typeof commandHint === "string" ? commandHint.trim() : "";

  if (HARD_LIMIT_TOOL_PATTERN.test(tool) || (command.length > 0 && (isHardLimitCommand(command) || SECRET_OR_AUTH_PATH_PATTERN.test(command)))) {
    return "hard-limit";
  }

  if (command.length > 0) {
    if (isHardLimitCommand(command)) return "hard-limit";
    if (PUSH_COMMAND_PATTERN.test(command)) return "high";
    if (SAFE_COMMAND_PATTERN.test(command)) return "off";
  }

  if (READ_ONLY_TOOLS.has(tool)) return "off";
  if (LOW_RISK_TOOLS.has(tool)) return "low";
  if (HIGH_RISK_TOOL_PATTERN.test(tool)) return "high";
  if (SHELL_TOOL_PATTERN.test(tool) || NETWORK_TOOL_PATTERN.test(tool)) return "medium";

  // An unrecognized tool is not treated as safe; high autonomy may run ordinary
  // high-risk work, but never a constitutional hard edge.
  return "high";
}

/** Compatibility alias for callers that name the operation by its risk. */
export const classifyRisk = classifyCommandRisk;

export function commandRiskRank(risk: CommandRiskClass): number {
  return COMMAND_RISK_ORDER[risk];
}
