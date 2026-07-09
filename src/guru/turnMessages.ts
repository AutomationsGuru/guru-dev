import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * Operator-facing turn result / failure lines + model-switch history helper.
 * Kept free of the full guru REPL import graph so tests stay hermetic on slow shares.
 */

/**
 * Switch models WITHOUT wiping the conversation. Only the system head is
 * refreshed; user/assistant turns stay. /new is the clean-slate path.
 */
export function preserveHistoryOnModelSwitch(
  history: readonly ChatTurnMessage[],
  nextSystemPrompt: string
): ChatTurnMessage[] {
  if (history.length === 0) {
    return [{ role: "system", content: nextSystemPrompt }];
  }
  if (history[0]?.role === "system") {
    return [{ role: "system", content: nextSystemPrompt }, ...history.slice(1)];
  }
  return [{ role: "system", content: nextSystemPrompt }, ...history];
}

/** Plain-text shape of an empty/tools-only turn (styling applied by the TUI). */
export function emptyTurnMessage(toolCallCount: number): string {
  if (toolCallCount > 0) {
    return `(no final text — ${toolCallCount} tool call(s) finished; type "summarize what you did" or try /model)`;
  }
  return "(empty response — provider returned no text; check /status, switch with /model, or rephrase)";
}

/** Optional dim follow-up line printed under an empty tools-only turn. */
export function emptyTurnFollowUpTip(toolCallCount: number): string | undefined {
  if (toolCallCount > 0) {
    return "tip: many models stop after tools — a short follow-up question usually gets a summary";
  }
  return undefined;
}

/** Plain-text tip line for a failed turn (styling applied by the TUI). */
export function turnFailureTip(message: string): string {
  if (/401|403|unauthor|credential|api.?key|login/iu.test(message)) {
    return "credential/login: /login · /keys · /accounts";
  }
  if (/timeout|ETIMEDOUT|aborted|network|ECONN|fetch failed/iu.test(message)) {
    return "network/timeout: esc interrupts hangs · try again or /model";
  }
  if (/429|rate.?limit/iu.test(message)) {
    return "rate limited: wait a moment, or /model to another route";
  }
  return "/status · /model · esc interrupts a hung turn";
}

export function abortTurnMessage(): string {
  return "(turn stopped — partial kept where available; continue or rephrase)";
}
