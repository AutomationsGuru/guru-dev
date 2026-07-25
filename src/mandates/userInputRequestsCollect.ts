import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * User Input Requests Collect (R-MA-USER-REQ, F260).
 *
 * Extracts pending approval/input requests from agent result messages into a
 * typed list. This is the collection half of the HITL approval loop: after a
 * turn produces assistant messages, collect() scans them for tool-use requests
 * that need operator approval before execution.
 *
 * Composes: F247 approval loop, F221 HITL function gate.
 */

/** A single pending user-input request extracted from an agent message. */
export interface UserInputRequest {
  /** The 1-based index of the message in the input array (for traceability). */
  readonly messageIndex: number;
  /** The tool or operation requesting approval. */
  readonly toolId: string;
  /** Human-readable reason for the request. */
  readonly reason: string;
  /** True when the request is a hard edge (destructive/spend/secrets/auth) that
   *  must always prompt — never auto-approvable. */
  readonly hardEdge: boolean;
}

/**
 * Marker patterns that signal a user-input/approval request in assistant text.
 * These match the structured markers the harness emits when a tool call needs
 * approval (the escalate path in evaluateToolMandate).
 *
 * Format: `[APPROVAL_REQUEST]` block with toolId, reason, and optional
 * `hardEdge` flag. Fallback: `(requires approval)` and `(hard edge)` keywords
 * in the reason text appended by the escalate outcome.
 */
const APPROVAL_MARKER = /\[APPROVAL_REQUEST\]\s*toolId=(\S+)\s+reason=(.+?)(?:\s+hardEdge=(true|false))?\s*$/m;
const REQUIRES_APPROVAL = /\(requires approval[^)]*\)/i;
const HARD_EDGE_KW = /\(hard edge[^)]*\)/i;

/**
 * Collect pending user-input/approval requests from a sequence of chat messages.
 *
 * Scans assistant-role messages for structured `[APPROVAL_REQUEST]` markers and
 * falls back to keyword-based detection (`requires approval`, `hard edge`).
 * Returns an empty list when no pending requests are found.
 *
 * Pure function — no side effects, no terminal I/O, injectable for testing.
 */
export function collect(messages: readonly ChatTurnMessage[]): readonly UserInputRequest[] {
  const requests: UserInputRequest[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as ChatTurnMessage;
    if (message.role !== "assistant") {
      continue;
    }

    const content = message.content;

    // Structured marker: [APPROVAL_REQUEST] toolId=<id> reason=<text> [hardEdge=true|false]
    const structured = APPROVAL_MARKER.exec(content);
    if (structured) {
      requests.push({
        messageIndex: i + 1, // 1-based for human readability
        toolId: structured[1] ?? "unknown",
        reason: (structured[2] ?? "").trim(),
        hardEdge: structured[3] === "true"
      });
      continue;
    }

    // Keyword fallback: the text contains "(requires approval)" — extract what
    // we can from the surrounding context.
    if (REQUIRES_APPROVAL.test(content)) {
      const hardEdge = HARD_EDGE_KW.test(content);
      // Try to infer the toolId from the message content.
      let toolId = "unknown";
      const toolMatch = /\btoolId[:=]\s*(\S+)/i.exec(content);
      if (toolMatch) {
        toolId = toolMatch[1] ?? "unknown";
      } else {
        // Look for common tool reference patterns in approval messages.
        const toolRef = /\b(bash|write|edit|web_fetch|web_search|git\.pr\.run|shell\.command\.run|provider_cli_run)\b/i.exec(content);
        if (toolRef) {
          toolId = toolRef[1] ?? "unknown";
        }
      }

      requests.push({
        messageIndex: i + 1,
        toolId,
        reason: "approval required",
        hardEdge
      });
    }
  }

  return requests;
}