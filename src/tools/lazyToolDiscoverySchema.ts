import { z } from "zod";

// ── Tool Pack ────────────────────────────────────────────────────────────────

/**
 * A named collection of tool IDs available for lazy discovery. Each pack
 * maps to one or more tool IDs. Prefix patterns ending in `.*` match all
 * tools whose id starts with that prefix (e.g. `mcp.*` matches `mcp.foo.bar`).
 */
export const ToolPackSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    toolIdPatterns: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();
export type ToolPack = z.infer<typeof ToolPackSchema>;

// ── State ────────────────────────────────────────────────────────────────────

export const LazyToolDiscoveryStateSchema = z
  .object({
    /** Sorted list of pack ids currently enabled. */
    enabledPacks: z.array(z.string().trim().min(1))
  })
  .strict();
export type LazyToolDiscoveryState = z.infer<typeof LazyToolDiscoveryStateSchema>;

// ── Core tool IDs (always visible) ───────────────────────────────────────────

/**
 * Tools that are always visible to the model, regardless of pack state.
 * These are the minimum set needed for safe, independent operation:
 * file I/O, typed exploration, and operator communication.
 */
export const CORE_TOOL_IDS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "ls",
  "ask_question"
]);

// ── Default packs ────────────────────────────────────────────────────────────

export const DEFAULT_PACKS: readonly ToolPack[] = [
  {
    id: "todo",
    title: "Task tracking",
    description: "Session task board for multi-step agent work (todo_write, todo_list).",
    toolIdPatterns: ["todo_write", "todo_list"]
  },
  {
    id: "web",
    title: "Web research",
    description: "Web search and fetch tools (web_search, web_fetch).",
    toolIdPatterns: ["web_search", "web_fetch"]
  },
  {
    id: "skills",
    title: "Skill loader",
    description: "Discover and load file-based GuruHarness skill documents.",
    toolIdPatterns: ["skills.catalog.list", "skill.document.load"]
  },
  {
    id: "mcp",
    title: "MCP bridge",
    description: "Model Context Protocol server status, tool discovery, and dispatch (mcp_bridge_status, search_tool, use_tool, plus all mcp.* bridged tools).",
    toolIdPatterns: ["mcp_bridge_status", "search_tool", "use_tool", "mcp.*"]
  },
  {
    id: "memory",
    title: "Fact memory",
    description: "Markdown/PostgreSQL fact memory CRUD and health (memory_remember, memory_search, memory_get, memory_forget, memory_doctor, memory_status).",
    toolIdPatterns: ["memory_remember", "memory_search", "memory_get", "memory_forget", "memory_doctor", "memory_status"]
  },
  {
    id: "honcho",
    title: "Honcho memory",
    description: "Honcho episodic memory integration (status, remember, recall, context, log_turn). Disabled by default; requires explicit configuration.",
    toolIdPatterns: ["honcho_memory_status", "honcho_remember", "honcho_recall", "honcho_context", "honcho_log_turn"]
  },
  {
    id: "github",
    title: "GitHub PR automation",
    description: "GitHub pull request status, comment, review, and automation (github.pr.status, github.pr.comment, github.pr.review, git.pr.run).",
    toolIdPatterns: ["github.pr.status", "github.pr.comment", "github.pr.review", "git.pr.run"]
  },
  {
    id: "provider-cli",
    title: "Provider CLI",
    description: "Provider CLI status inspection and delegated runs (provider_cli_status, provider_cli_run). Dry-run-first; gated by explicit policy.",
    toolIdPatterns: ["provider_cli_status", "provider_cli_run"]
  },
  {
    id: "desktop",
    title: "Desktop automation",
    description: "Screen, mouse, and keyboard automation (pyautogui_status, pyautogui_screen, pyautogui_mouse, pyautogui_keyboard). Dry-run-first; live mode gated by GURU_DESKTOP_LIVE.",
    toolIdPatterns: ["pyautogui_status", "pyautogui_screen", "pyautogui_mouse", "pyautogui_keyboard"]
  },
  {
    id: "operational",
    title: "Operational store",
    description: "Project, blocker, state snapshot, decision, backlog, and implementation tracking (operational.*).",
    toolIdPatterns: ["operational.project.get", "operational.blocker.record", "operational.state.write", "operational.state.list", "operational.decision.upsert", "operational.backlog.create", "operational.backlog.list", "operational.implementation.create"]
  },
  {
    id: "shell",
    title: "Shell & file editing",
    description: "Guarded shell execution and alternative file editing (shell.command.run, fs.edit.apply).",
    toolIdPatterns: ["shell.command.run", "fs.edit.apply"]
  },
  {
    id: "maintenance",
    title: "Maintenance audit",
    description: "Run a maintenance audit over the workspace (maintenance.audit.run).",
    toolIdPatterns: ["maintenance.audit.run"]
  },
  {
    id: "review",
    title: "Review gates",
    description: "Run configured review-gate validation commands (review.gates.run).",
    toolIdPatterns: ["review.gates.run"]
  },
  {
    id: "repo",
    title: "Repository context",
    description: "Resolve repository root, status, and AGENTS chain (repo.context.resolve).",
    toolIdPatterns: ["repo.context.resolve"]
  },
  {
    id: "swarm",
    title: "Agent swarm",
    description: "Spawn, observe, and kill child agents (spawn_agent, get_task_output, kill_task).",
    toolIdPatterns: ["spawn_agent", "get_task_output", "kill_task"]
  },
  {
    id: "monitor",
    title: "Background monitor",
    description: "Stream background task output lines as events (monitor).",
    toolIdPatterns: ["monitor"]
  },
  {
    id: "schedule",
    title: "Scheduling",
    description: "Schedule one-shot in-process notifications (schedule). Recurring cron not yet implemented.",
    toolIdPatterns: ["schedule"]
  },
  {
    id: "manage-task",
    title: "Task management",
    description: "Manage background tasks — cancel, list, read output lines (manage_task).",
    toolIdPatterns: ["manage_task"]
  },
  {
    id: "lsp",
    title: "Language server",
    description: "Language Server Protocol diagnostics and navigation (lsp).",
    toolIdPatterns: ["lsp"]
  },
  {
    id: "diagnostics",
    title: "Read diagnostics",
    description: "Read TypeScript/ESLint compiler diagnostics (read_diagnostics).",
    toolIdPatterns: ["read_diagnostics"]
  }
];
