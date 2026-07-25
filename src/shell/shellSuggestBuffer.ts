/**
 * Shell suggest buffer (IDEA-F112-SHELL-BRIDGE-01, R-FC-SUGGEST residual).
 *
 * `suggestToBuffer` is the pure half of the shell prompt bridge: given a
 * newline / buffer line captured by a shell integration (ZSH `:` prefix mode
 * or any other shell — this API is shell-agnostic), it returns the shell
 * command string the operator would want staged in the buffer. It NEVER
 * executes anything — no child_process, no I/O, no network. Execution
 * decisions belong to the session layer above this module.
 */

/**
 * Normalize a captured buffer line into the command string to stage.
 *
 * Rules: strip leading/trailing whitespace and collapse interior whitespace
 * runs (spaces, tabs, newlines) into single spaces. Blank input yields "".
 */
export function suggestToBuffer(nl: string): string {
  return nl.replace(/\s+/g, " ").trim();
}
