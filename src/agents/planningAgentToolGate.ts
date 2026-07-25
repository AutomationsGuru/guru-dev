/**
 * Planning-agent tool gate.
 *
 * The planning-agent profile exists to draft plans, not to execute them. This
 * module is the profile's tool gate: a pure, deterministic predicate over tool
 * ids that admits read/search/plan-artifact tools only and blocks write and
 * shell-risk tools even when the session is running under high autonomy.
 *
 * The gate is ADVISORY / defense-in-depth. It sits IN FRONT OF — never instead
 * of — the mandate floor (`MANDATE_READ_ONLY_TOOLS` / verb gating in
 * `src/mandates/evaluate.ts`) and the `effect === "read-only"` certification in
 * `src/planner/planMode.ts`. Those layers keep their own authority; this gate
 * narrows what a plan-agent profile will even attempt so a high-autonomy
 * session cannot be talked into mutating the tree it was asked only to study.
 *
 * Design contract:
 * - ALLOW: read-only inspection, bounded web research, memory/session-board
 *   reads, probes, Q&A, and the plan-artifact board (`todo_write` — process
 *   memory only, never disk; without it the planner cannot record its draft).
 * - DENY (write/shell-risk): filesystem writes, shell exec, memory writes,
 *   operational writes, delegated CLI runs, desktop actuation, MCP dispatch,
 *   and spawn/lifecycle tools. Spawn is denied because a planner that spawns a
 *   worker able to mutate would route around this gate.
 * - DENY (unknown): fail-closed — any id not on the explicit allowlist is
 *   denied, so newly registered tools are safe-by-default until reviewed.
 */

/** Classification of a tool id under the planning-agent gate. */
export type PlanningAgentToolClassification = "allow" | "deny-write-shell" | "deny-unknown";

/**
 * The canonical planning-agent allowlist. Membership is all that matters;
 * order is grouped by purpose for review.
 *
 * Exported behind an immutable facade: `Object.freeze` alone does NOT seal a
 * Set (its internal slots stay writable via `add`/`delete`/`clear`), so the
 * export is a Proxy whose mutation methods throw `TypeError` and whose own
 * property writes are rejected. Runtime enlargement of the gate is impossible.
 */
const allowedToolIds = new Set<string>([
  // Read-only inspection.
  "read",
  "grep",
  "glob",
  "ls",
  "find",
  "lsp",
  "read_diagnostics",
  "monitor",
  "repo.context.resolve",
  // Bounded web research.
  "web_fetch",
  "web_search",
  // Memory reads (never writes).
  "memory_search",
  "memory_get",
  "memory_status",
  "honcho_memory_status",
  "honcho_recall",
  "honcho_context",
  // Session task board — the planner's plan-artifact working surface.
  // Process memory only; never touches the filesystem.
  "todo_write",
  "todo_list",
  "manage_task",
  "get_task_output",
  // Operator Q&A — no mutation.
  "ask_question",
  // Discovery / probes (registry lookups, PATH presence, status snapshots).
  "search_tool",
  "mcp_bridge_status",
  "provider_cli_status",
  "pyautogui_status",
  "pyautogui_screen",
  "service_readiness_report",
  "resolve_capability_gap",
  "skills.catalog.list",
  "skill.document.load",
  // Operational reads.
  "operational.project.get",
  "operational.state.list",
  "operational.backlog.list",
  "github.pr.status"
]);

export const PLANNING_AGENT_ALLOWED_TOOL_IDS: ReadonlySet<string> = new Proxy(allowedToolIds, {
  get(target, property) {
    if (property === "add" || property === "delete" || property === "clear") {
      return (): never => {
        throw new TypeError("PLANNING_AGENT_ALLOWED_TOOL_IDS is immutable.");
      };
    }
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  set() {
    throw new TypeError("PLANNING_AGENT_ALLOWED_TOOL_IDS is immutable.");
  },
  defineProperty() {
    throw new TypeError("PLANNING_AGENT_ALLOWED_TOOL_IDS is immutable.");
  },
  deleteProperty() {
    throw new TypeError("PLANNING_AGENT_ALLOWED_TOOL_IDS is immutable.");
  }
});

/**
 * Known write/shell-risk tool ids, kept explicit so `classifyTool` can explain
 * a denial as "recognized but forbidden" rather than "unknown". Membership in
 * this set is not required for denial — anything off the allowlist is denied —
 * but naming the known-bad ids keeps diagnostics honest when the registry
 * gains new mutating tools.
 */
const PLANNING_AGENT_KNOWN_WRITE_SHELL_TOOL_IDS: ReadonlySet<string> = new Set<string>([
  // Filesystem writes.
  "write",
  "edit",
  "fs.edit.apply",
  // Shell exec.
  "bash",
  "shell.command.run",
  // Memory writes.
  "memory_remember",
  "memory_forget",
  "memory_doctor",
  "honcho_remember",
  "honcho_log_turn",
  // Operational writes.
  "operational.state.write",
  "operational.decision.upsert",
  "operational.backlog.create",
  "operational.implementation.create",
  "operational.blocker.record",
  // Git/GitHub mutation and review execution.
  "git.pr.run",
  "github.pr.comment",
  "github.pr.review",
  "review.gates.run",
  // Delegated provider CLI (shells out, may spend).
  "provider_cli_run",
  // Desktop actuation.
  "pyautogui_mouse",
  "pyautogui_keyboard",
  // MCP meta-dispatch (conservatively write-class upstream).
  "use_tool",
  // Spawn/lifecycle — a spawned worker able to mutate would defeat the gate.
  "spawn_agent",
  "kill_task"
]);

/**
 * Pure, deterministic allow check for the planning-agent profile. True only
 * for ids on the explicit allowlist; every other id — known mutator, spawn
 * tool, or unrecognized — is denied (fail-closed). Exact, case-sensitive id
 * match; no trimming or normalization.
 */
export function isAllowed(toolId: string): boolean {
  return PLANNING_AGENT_ALLOWED_TOOL_IDS.has(toolId);
}

/**
 * Explain the gate's decision for a tool id:
 * - `"allow"` — on the planning-agent allowlist.
 * - `"deny-write-shell"` — a recognized write/shell-risk tool the profile
 *   must never call, even under high autonomy.
 * - `"deny-unknown"` — not recognized; denied fail-closed.
 *
 * Always consistent with {@link isAllowed}: only `"allow"` permits the call.
 */
export function classifyTool(toolId: string): PlanningAgentToolClassification {
  if (PLANNING_AGENT_ALLOWED_TOOL_IDS.has(toolId)) {
    return "allow";
  }
  if (PLANNING_AGENT_KNOWN_WRITE_SHELL_TOOL_IDS.has(toolId)) {
    return "deny-write-shell";
  }
  return "deny-unknown";
}
