/**
 * Ask / scout posture — an opt-in, default-off session mode that denies file
 * mutation and side-effecting shell tools while allowing chat, read, search, and
 * other read-only operations. The operator enters with `/ask` (or an equivalent
 * command) and exits with `/exit ask` (or a dedicated exit command). While the
 * flag is set, the harness behaves like a read-only scout: it can inspect and
 * reason, but it cannot touch disk or execute commands.
 *
 * This module owns only the policy data and the pre-tool gate. It does NOT own
 * the mandate evaluator, the TUI command parser, or the session event bus. The
 * posture flag is sticky per session (not persisted to disk), and transitions
 * are recorded as receipts so the session log is truthful about when the mode
 * changed.
 *
 * Design notes:
 * - Opt-in / default-off: normal YOLO work is unaffected unless the operator
 *   explicitly enters ask mode. This avoids reintroducing routine friction.
 * - Deny precedes ordinary mandate evaluation: ask mode is a session-scoped
 *   deny layer, not a grant, so it survives YOLO and does not interact with the
 *   grant/deny state in the mandate store.
 * - Read-only tools are allowed; mutation classes (write, exec, net) are denied.
 *   "net" is denied because even baseline network calls can have observable
 *   side effects on the operator's behalf.
 * - The exit command clears the flag and returns a receipt describing the
 *   transition.
 */

export interface AskPostureReceipt {
  /** The transition that happened. */
  readonly kind: "enter" | "exit";
  /** Human-readable description of the transition, suitable for a session log. */
  readonly message: string;
  /** ISO timestamp of the transition. */
  readonly at: string;
}

/** Per-session mutable state for ask posture. Tests pass a plain object. */
export interface AskPostureSession {
  /** True when the session is currently in ask/scout posture. */
  askMode: boolean;
}

/** Tools that remain allowed while in ask posture. Everything else is denied. */
export const ASK_POSTURE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
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
  "read_diagnostics",
  "monitor",
  "lsp",
  // These tools only inspect existing state but are not part of the mandate's
  // always-allowed floor.
  "get_task_output",
  "resolve_capability_gap",
  "pyautogui_screen"
]);

/** Enter ask posture and return a receipt describing the transition. */
export function enterAskPosture(session: AskPostureSession, now = () => new Date()): AskPostureReceipt {
  const alreadyIn = session.askMode;
  session.askMode = true;
  return {
    kind: "enter",
    message: alreadyIn
      ? "ask posture already active; remaining in read-only scout mode"
      : "entered ask posture: file writes, shell execution, and network tools are denied until you exit",
    at: now().toISOString()
  };
}

/** Exit ask posture and return a receipt describing the transition. */
export function exitAskPosture(session: AskPostureSession, now = () => new Date()): AskPostureReceipt {
  const wasIn = session.askMode;
  session.askMode = false;
  return {
    kind: "exit",
    message: wasIn
      ? "exited ask posture: ordinary mandate permissions apply again"
      : "ask posture was already inactive; no mode change",
    at: now().toISOString()
  };
}

/** True when the tool is allowed in ask posture. */
export function isAskPostureAllowedTool(toolId: string): boolean {
  return ASK_POSTURE_READ_ONLY_TOOLS.has(toolId);
}

/** The reason string used when a tool is denied by ask posture. */
export function askPostureDenyReason(toolId: string): string {
  return `ask posture active: ${toolId} is blocked (read-only / chat tools remain available; use /exit ask to resume)`;
}

/**
 * Evaluate a tool under ask posture. Returns `denied: true` with a reason for
 * every tool outside the explicit read-only list while the mode is active;
 * otherwise returns `denied: false`. This is a pre-tool gate: the caller should
 * still run the ordinary mandate
 * evaluator when the gate passes, because ask posture is orthogonal to grants,
 * YOLO, and hard edges.
 */
export function evaluateAskPostureGate(
  toolId: string,
  session: AskPostureSession
): { readonly denied: boolean; readonly reason: string } {
  if (!session.askMode) {
    return { denied: false, reason: "" };
  }
  if (isAskPostureAllowedTool(toolId)) {
    return { denied: false, reason: "" };
  }
  return { denied: true, reason: askPostureDenyReason(toolId) };
}
