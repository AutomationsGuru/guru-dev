/**
 * Tool approval mode table — per-tool-class mode resolution.
 *
 * Maps tool classes (bash, write, web_fetch, …) to one of three modes:
 * - `auto`  — auto-approve (bypass interactive prompt)
 * - `ask`   — ask the operator (default, fail-closed)
 * - `deny`  — deny
 *
 * The default is `ask` — an absent entry never weakens to `auto` or `deny`.
 * This table is a policy layer consulted BEFORE per-call mandate evaluation;
 * `deny` here short-circuits (never reaches the mandate), `auto` skips the
 * interactive prompt, and `ask` falls through to normal mandate evaluation.
 *
 * Hard limits (destructive, spend, secret-edge, auth-edge) are enforced
 * downstream by the mandate evaluator and are NOT weakened by `auto` entries
 * in this table.
 */

/** A per-tool-class approval mode. */
export type ToolApprovalMode = "auto" | "ask" | "deny";

/**
 * A table mapping tool classes to approval modes.
 * Entries not in the table default to `"ask"` (fail-closed).
 */
export type ToolApprovalModeTable = Readonly<Record<string, ToolApprovalMode>>;

/**
 * Resolve the approval mode for a tool class against a table.
 *
 * Resolution order:
 * 1. Exact key match in the table → that mode.
 * 2. No match → `"ask"` (default fail-closed).
 *
 * This is a pure function — it never mutates the table, never performs I/O,
 * and never weakens hard limits. Callers are responsible for ensuring that
 * `auto` does not bypass hard-edge escalation downstream.
 */
export function resolveToolApprovalMode(
  toolClass: string,
  table: ToolApprovalModeTable,
): ToolApprovalMode {
  return table[toolClass] ?? "ask";
}
