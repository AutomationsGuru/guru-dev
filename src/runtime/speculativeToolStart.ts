/**
 * Speculative tool start (IDEA-F105-SPEC-TOOL-START-01).
 *
 * When a tool_call is *complete* mid-stream (its argument JSON is final, before
 * the assistant message has finished streaming), the harness may start a
 * **read-only / approved** tool early so its result is ready when the post-stream
 * executor would otherwise begin. Mutating and shell-risk tools still wait for
 * the same gates they always meet post-stream.
 *
 * This module is a standalone, framework-free building block. It does not edit
 * the agent loop (the frozen core); the loop wires it through its existing
 * `onToolPending` / `approveTool` seams. All five hard limits are enforced
 * structurally HERE, before any speculative execution, and resolve BEFORE any
 * "auto-start" — YOLO and unattended loops cannot lift them.
 *
 * Vision alignment:
 * - §1.2 lightweight + frozen seam: new capability is a module, not a core edit.
 * - §1.7 YOLO-by-default inside the constitution: routine read-only work starts
 *   early without a prompt, but the five hard limits (§3) bind first.
 * - §3.1 no destruction: only read-only tools may start speculatively.
 * - §3.2 no unapproved spend: a `spendRequired` tool is denied by the
 *   `$0`-denies-all default ceiling.
 * - §3.3 no leaked secrets: secret exposure is prevented by NAME only; the
 *   harness never reads a value, it only knows a blocked name was referenced.
 * - §4 friction drift avoided: routine reads keep flowing; hard edges escalate.
 */

/**
 * The structural capability marker a speculative start trusts. This mirrors the
 * registry's `ToolEffect` (G1004 plan-mode gate): `"read-only"` is the only
 * effect that may start before the assistant message finishes; `"mutating"` and
 * omission are untrusted and always wait. Omission is never granted read-only
 * trust — a tool that has not declared its effect cannot be speculated.
 */
export type SpeculativeToolEffect = "read-only" | "mutating";

/**
 * Minimal tool shape this module reasons about. It intentionally does not import
 * the registry's `ToolDefinition` (no core coupling): classification trusts only
 * the structural `effect` marker, so any tool that carries `effect ===
 * "read-only"` is speculative-safe regardless of its schema library.
 */
export interface SpeculativeTool {
  readonly id: string;
  readonly effect?: SpeculativeToolEffect;
  readonly execute?: (input: unknown) => Promise<unknown> | unknown;
}

/** Classification result: may this tool start speculatively? */
export type SpeculativeClassification = "speculative-safe" | "must-wait";

/**
 * Classify a tool for speculative start. Trust ONLY an explicit
 * `effect === "read-only"` declaration; everything else (mutating, shell-risk,
 * or unmarked) waits for the post-stream gates.
 */
export function classifySpeculative(tool: SpeculativeTool): SpeculativeClassification {
  return tool.effect === "read-only" ? "speculative-safe" : "must-wait";
}

/**
 * Approval policy seam. Returns true to ALLOW a speculative start. This is the
 * same gate the post-stream executor runs (`approveTool`); speculative start
 * runs it EARLY so the operator's standing decision applies before dead time.
 */
export interface SpeculativeApprovalPolicy {
  approve: (toolId: string, input: unknown) => boolean | Promise<boolean>;
}

/**
 * Hard-limit seam (Vision §3). Every predicate is consulted BEFORE any
 * speculative execution and BEFORE the approval gate. A hard-limit denial can
 * never be lifted by YOLO, an approval, or an unattended loop.
 *
 *  - `spendRequired`: when true, the call costs money / paid quota. Under the
 *    default `$0`-denies-all ceiling (`approveSpend` resolves false) it is
 *    blocked. Unknown cost is not free.
 *  - `approveSpend`: the spend budget authority. Defaults to deny-all so
 *    unattended speculative work cannot move money.
 *  - `blockedSecretNames`: input field VALUES (paths, names) flagged by NAME
 *    only — the harness never inspects a secret value, it only matches a
 *    presence/name against this list.
 */
export interface SpeculativeHardLimitPolicy {
  readonly spendRequired?: boolean;
  readonly approveSpend?: () => boolean | Promise<boolean>;
  readonly blockedSecretNames?: readonly string[];
}

/** The outcome a speculative execution produces for the caller. */
export interface SpeculativeToolResult {
  readonly status: "succeeded" | "failed";
  readonly output?: unknown;
  readonly error?: string;
}

/**
 * Executor seam. The caller supplies how a tool actually runs (so this module
 * stays free of registry/IO coupling). Receives a per-start AbortSignal so a
 * stream abort or a later policy denial can cancel an in-flight read.
 */
export type SpeculativeExecutor = (
  toolId: string,
  input: unknown,
  signal: AbortSignal | undefined
) => Promise<SpeculativeToolResult>;

export interface ScheduleSpeculativeToolStartOptions {
  readonly tool: SpeculativeTool;
  /** Already-parsed complete tool arguments (preferred). */
  readonly completeArguments?: unknown;
  /** Raw complete argument JSON text (used when `completeArguments` is absent). */
  readonly completeArgumentsText?: string;
  readonly approval: SpeculativeApprovalPolicy;
  readonly hardLimits: SpeculativeHardLimitPolicy;
  readonly execute: SpeculativeExecutor;
  /** Stream abort signal: if already aborted, nothing speculative starts. */
  readonly streamSignal?: AbortSignal;
}

/** A speculative start that fired. The caller awaits `done` and may `cancel`. */
export interface SpeculativeStart {
  readonly kind: "started";
  readonly toolId: string;
  readonly input: unknown;
  /** Resolves with the speculative result. Rejects only on a genuine executor throw. */
  readonly done: Promise<SpeculativeToolResult>;
  /** Cancel an in-flight start (stream aborted or policy denied later). */
  cancel: (reason: string) => void;
}

/** A speculative start that correctly did NOT fire. Carries the reasons. */
export interface SpeculativeWait {
  readonly kind: "wait";
  readonly toolId: string;
  readonly reasons: readonly string[];
}

/** A speculative start suppressed because the stream was already aborted. */
export interface SpeculativeCancelled {
  readonly kind: "cancelled";
  readonly toolId: string;
  readonly reason: string;
}

export type SpeculativeDecision = SpeculativeStart | SpeculativeWait | SpeculativeCancelled;

/**
 * Evaluate a complete mid-stream tool_call for a speculative start.
 *
 * Decision order (hard limits resolve first, then approval, then execution):
 *  1. Stream abort → `cancelled` (no speculative action after the operator cancels).
 *  2. Argument parse → `wait` if the complete JSON is malformed (never act on bad args).
 *  3. Classification → `wait` unless the tool is structurally read-only.
 *  4. Hard limits → `wait` if spend is required + unapproved, or a blocked secret name is referenced.
 *  5. Approval → `wait` if the standing approval policy denies.
 *  6. Otherwise → `started`: run the read-only tool early, return a cancelable handle.
 */
export async function scheduleSpeculativeToolStart(
  options: ScheduleSpeculativeToolStartOptions
): Promise<SpeculativeDecision> {
  const { tool, approval, hardLimits, execute, streamSignal } = options;
  const toolId = tool.id;

  // 1. Abort is an action boundary (mirrors agentTurn's performToolCall): a
  //    cancel that has already landed means no new speculative action proceeds.
  if (streamSignal?.aborted) {
    return { kind: "cancelled", toolId, reason: "Stream aborted before speculative start." };
  }

  // 2. Resolve the complete arguments. Prefer the parsed object; fall back to text.
  let input: unknown;
  if (options.completeArguments !== undefined) {
    input = options.completeArguments;
  } else if (options.completeArgumentsText !== undefined) {
    try {
      input = JSON.parse(options.completeArgumentsText) as unknown;
    } catch {
      return { kind: "wait", toolId, reasons: ["Tool call arguments were invalid JSON."] };
    }
  } else {
    input = {};
  }

  const reasons: string[] = [];

  // 3. Classification: only an explicit read-only tool may start speculatively.
  if (classifySpeculative(tool) !== "speculative-safe") {
    reasons.push("tool is not speculative-safe (effect !== read-only)");
  }

  // 4. Hard limits (Vision §3) — resolve BEFORE approval and BEFORE execution.
  if (hardLimits.spendRequired) {
    const approved = await (hardLimits.approveSpend ?? asyncDenySpend)();
    if (!approved) {
      reasons.push("hard limit: unapproved spend blocked (spendRequired, $0-denies-all ceiling)");
    }
  }
  if (referencesBlockedSecret(input, hardLimits.blockedSecretNames)) {
    reasons.push("hard limit: blocked secret name referenced (presence/name only, value never read)");
  }

  // 5. Approval gate (the operator's standing decision, applied early).
  let approved = true;
  if (reasons.length === 0) {
    approved = await approval.approve(toolId, input);
    if (!approved) {
      reasons.push("blocked by approval policy (operator declined speculative start)");
    }
  }

  if (reasons.length > 0 || !approved) {
    return { kind: "wait", toolId, reasons };
  }

  // 6. Re-check abort after the (possibly async) approval, then start.
  if (streamSignal?.aborted) {
    return { kind: "cancelled", toolId, reason: "Stream aborted during speculative approval." };
  }

  // Compose the stream signal into a per-start controller so cancel() and a
  // stream abort both reach the executor as one abort.
  const controller = new AbortController();
  const onStreamAbort = (): void => controller.abort();
  if (streamSignal) {
    streamSignal.addEventListener("abort", onStreamAbort, { once: true });
  }

  const done = execute(toolId, input, controller.signal).finally(() => {
    if (streamSignal) {
      streamSignal.removeEventListener("abort", onStreamAbort);
    }
  });

  return {
    kind: "started",
    toolId,
    input,
    done,
    cancel: (reason: string): void => {
      controller.abort();
      void reason;
    }
  };
}

/**
 * Default spend authority: deny all. Unknown cost is not free (Vision §3.2), so
 * an unattended speculative start with no explicit spend budget can never move
 * money. The operator supplies `approveSpend` to lift this for budgeted work.
 */
async function asyncDenySpend(): Promise<boolean> {
  return false;
}

/**
 * Does the input reference a blocked secret NAME? The harness matches only the
 * presence of a known-blocked name/path in any string field VALUE — it never
 * reads, parses, or logs a secret value (Vision §3.3).
 */
function referencesBlockedSecret(input: unknown, blockedNames: readonly string[] | undefined): boolean {
  if (!blockedNames || blockedNames.length === 0) {
    return false;
  }
  const visited: string[] = [];
  collectStringValues(input, visited, 0);
  if (visited.length === 0) {
    return false;
  }
  return blockedNames.some((name) => visited.some((value) => value.includes(name)));
}

/** Depth-bounded walk over JSON-ish input collecting string values (by value, not secret content). */
function collectStringValues(value: unknown, out: string[], depth: number): void {
  if (depth > 6) {
    return;
  }
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, out, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const fieldValue of Object.values(value as Record<string, unknown>)) {
      collectStringValues(fieldValue, out, depth + 1);
    }
  }
}
