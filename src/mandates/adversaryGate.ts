import { verbsForCall } from "./evaluate.js";
import { riskClassForVerbs, type AdversaryPolicy } from "./adversaryPolicy.js";

/**
 * Adversary pre-tool gate (IDEA-F2) — an OPTIONAL, subordinate second opinion
 * ahead of tool execution. An independent judge (a second model/route, injected
 * by the caller) reviews selected tool calls against the original task, recent
 * messages, and the operator's policy markdown, and returns ALLOW or BLOCK.
 *
 * Constitutional posture — enforced here in code, not in prompts:
 *
 * - The gate can only TIGHTEN. It runs AHEAD of the structural mandate floor
 *   (`evaluateToolMandate`); an adversary ALLOW never lifts a deny or hard edge
 *   downstream, and a judge is never consulted about whether hard limits apply.
 * - Hard-limit and unknown-risk calls ALWAYS fail closed: if the judge errors,
 *   times out, or returns garbage, those calls are denied. Only calls whose
 *   verbs classify `standard` (read-only) may fail open, and only when the
 *   operator's policy explicitly opts in via `fail_open: true`.
 * - No policy, no gate: with no enabled `adversary.md` the gate is disabled and
 *   every call passes straight through to the mandate floor.
 * - No judge, no gate: the judge is a pure injected function. There is no
 *   built-in cloud call, no default route, no silent dependency. A wiring lane
 *   that forgets the judge gets a structurally disabled gate, not a fallback.
 * - BLOCK is sticky: the returned decision carries `mustNotRetry: true`, which
 *   wiring surfaces to the agent — it must not auto-retry the same call without
 *   an operator change.
 */

/** The injected second-opinion function. Wiring supplies the critic/adversary route. */
export type AdversaryJudge = (request: AdversaryJudgeRequest) => Promise<string>;

export interface AdversaryJudgeRequest {
  /** The assembled review prompt (task + recent context + call + policy). */
  readonly prompt: string;
  /** Tool id under review (for route-level logging/metrics). */
  readonly toolId: string;
}

export interface AdversaryGateCall {
  readonly toolId: string;
  readonly input: unknown;
}

export interface AdversaryGateContext {
  /** The original operator task/goal the agent is working under. */
  readonly originalTask: string;
  /** Recent conversation turns (the gate summarizes the tail itself). */
  readonly recentMessages?: readonly string[];
}

export interface AdversaryGateOptions {
  /** Resolved policy from loadAdversaryPolicy(). */
  readonly policy: AdversaryPolicy;
  /** Injected judge. Absent → gate disabled (no silent dependency). */
  readonly judge?: AdversaryJudge;
  /** Judge latency bound in ms (test seam); defaults to JUDGE_TIMEOUT_MS. */
  readonly judgeTimeoutMs?: number;
}

export type AdversaryGateCode =
  | "adversary_disabled"
  | "tool_not_reviewed"
  | "adversary_allow"
  | "adversary_block"
  | "adversary_parse_error"
  | "adversary_judge_error"
  | "adversary_fail_open_soft";

export interface AdversaryGateDecision {
  /** True = proceed to the mandate floor; false = deny the tool call. */
  readonly allow: boolean;
  readonly code: AdversaryGateCode;
  readonly reason: string;
  /**
   * True on every adversary BLOCK: the agent must not auto-retry the same call
   * without an operator change (plan step 5).
   */
  readonly mustNotRetry: boolean;
  /** The risk class the call was evaluated under (surfacing). */
  readonly riskClass: "hard-limit" | "unknown" | "standard";
}

const DECISION_ALLOW: Readonly<Pick<AdversaryGateDecision, "allow" | "mustNotRetry">> = { allow: true, mustNotRetry: false };
const DECISION_DENY: Readonly<Pick<AdversaryGateDecision, "allow" | "mustNotRetry">> = { allow: false, mustNotRetry: true };

/** How much of each side of the prompt a single field may occupy (bounded prompt). */
const MAX_TASK_CHARS = 4000;
const MAX_MESSAGE_CHARS = 1000;
const MAX_RECENT_MESSAGES = 8;
const MAX_INPUT_CHARS = 4000;
const MAX_POLICY_CHARS = 4000;
/** Hard upper bound on judge latency: a hung judge resolves as a judge error. */
const JUDGE_TIMEOUT_MS = 30_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/** Builds the review prompt: original goal + recent tail + call + policy text. */
export function buildAdversaryPrompt(call: AdversaryGateCall, ctx: AdversaryGateContext, policy: AdversaryPolicy): string {
  const tail = (ctx.recentMessages ?? []).slice(-MAX_RECENT_MESSAGES).map((message) => `- ${clip(message, MAX_MESSAGE_CHARS)}`);
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(call.input) ?? String(call.input);
  } catch {
    serializedInput = "[unserializable tool input]";
  }
  const policyText = [policy.homeBody, policy.overlayBody].filter((body) => body.trim().length > 0).join("\n\n");

  return [
    "You are an independent adversarial reviewer for an AI agent harness. Review the",
    "pending tool call against the operator's original task, the recent conversation,",
    "and the operator's adversary policy. Reply with exactly one verdict line:",
    "ALLOW or BLOCK, followed by a short reason. BLOCK when the call is destructive,",
    "exfiltrating, secret-exposing, billable, off-task, or policy-violating.",
    "",
    "## Original task",
    clip(ctx.originalTask, MAX_TASK_CHARS),
    "",
    "## Recent messages",
    ...(tail.length > 0 ? tail : ["- (none)"]),
    "",
    "## Tool call under review",
    `tool: ${call.toolId}`,
    `input: ${clip(serializedInput, MAX_INPUT_CHARS)}`,
    "",
    "## Operator adversary policy",
    clip(policyText, MAX_POLICY_CHARS),
    "",
    "Verdict (ALLOW or BLOCK):"
  ].join("\n");
}

/** Parses the judge's reply. Throws on anything but an explicit ALLOW/BLOCK. */
export function parseAdversaryVerdict(raw: string): { readonly verdict: "allow" | "block"; readonly reason: string } {
  const match = raw.match(/\b(ALLOW|BLOCK)\b/u);
  const token = match?.[1];
  if (!match || token === undefined) {
    throw new Error("adversary reply carried no ALLOW/BLOCK verdict");
  }
  const verdict = token === "ALLOW" ? ("allow" as const) : ("block" as const);
  const reason = raw.slice((match.index ?? 0) + token.length).replace(/^[:\s-]+/u, "").trim();
  return { verdict, reason: reason.length > 0 ? clip(reason, 500) : `judge returned ${token}` };
}

/**
 * Evaluates one tool call. Fail-closed matrix (plan step 6):
 *
 * | judge outcome          | hard-limit | unknown | standard            |
 * | ---------------------- | ---------- | ------- | ------------------- |
 * | explicit ALLOW         | pass-through* | pass-through* | pass-through* |
 * | explicit BLOCK         | deny       | deny    | deny                |
 * | error / parse failure  | deny       | deny    | deny, unless policy |
 * |                        |            |         | fail_open → allow   |
 *
 * *"pass-through" = the ADVERSARY allows; the structural mandate floor still
 * evaluates the call downstream and can deny or escalate it.
 */
export async function evaluateAdversaryGate(
  call: AdversaryGateCall,
  ctx: AdversaryGateContext,
  options: AdversaryGateOptions
): Promise<AdversaryGateDecision> {
  const { policy, judge } = options;
  const verbs = verbsForCall(call.toolId, call.input);
  const riskClass = riskClassForVerbs(verbs);

  if (!policy.enabled || judge === undefined) {
    return {
      ...DECISION_ALLOW,
      code: "adversary_disabled",
      reason: "adversary gate disabled (no enabled policy or no judge configured) — mandate floor applies",
      riskClass
    };
  }

  if (!policy.reviewedTools.includes(call.toolId)) {
    return {
      ...DECISION_ALLOW,
      code: "tool_not_reviewed",
      reason: `tool ${call.toolId} is outside the adversary review scope — mandate floor applies`,
      riskClass
    };
  }

  const prompt = buildAdversaryPrompt(call, ctx, policy);
  const judgeTimeoutMs = options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS;

  let raw: string;
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`adversary judge exceeded ${judgeTimeoutMs}ms`)), judgeTimeoutMs);
    });
    try {
      raw = await Promise.race([judge({ prompt, toolId: call.toolId }), timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return failClosedOrSoft(error instanceof Error ? error.message : String(error), "adversary_judge_error", riskClass, policy);
  }

  let verdict: { readonly verdict: "allow" | "block"; readonly reason: string };
  try {
    verdict = parseAdversaryVerdict(raw);
  } catch (error) {
    return failClosedOrSoft(error instanceof Error ? error.message : String(error), "adversary_parse_error", riskClass, policy);
  }

  if (verdict.verdict === "block") {
    return {
      ...DECISION_DENY,
      code: "adversary_block",
      reason: `adversary BLOCK: ${verdict.reason}`,
      riskClass
    };
  }

  return {
    ...DECISION_ALLOW,
    code: "adversary_allow",
    reason: `adversary ALLOW: ${verdict.reason} — mandate floor still applies`,
    riskClass
  };
}

/**
 * The fail-closed choke: judge/parse failures deny hard-limit and unknown-risk
 * calls unconditionally. Only `standard` (read-only-classified) calls may pass,
 * and only under an explicit operator `fail_open` policy header.
 */
function failClosedOrSoft(
  error: string,
  code: "adversary_judge_error" | "adversary_parse_error",
  riskClass: "hard-limit" | "unknown" | "standard",
  policy: AdversaryPolicy
): AdversaryGateDecision {
  if (riskClass === "standard" && policy.failOpenSoft) {
    return {
      ...DECISION_ALLOW,
      code: "adversary_fail_open_soft",
      reason: `adversary ${code === "adversary_judge_error" ? "judge error" : "parse failure"} (${error}) — policy fail_open permits read-only-class calls only`,
      riskClass
    };
  }
  return {
    ...DECISION_DENY,
    code,
    reason: `adversary ${code === "adversary_judge_error" ? "judge error" : "parse failure"} (${error}) — fail-closed for ${riskClass} risk class`,
    riskClass
  };
}
