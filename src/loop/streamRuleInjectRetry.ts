import { z } from "zod";

/**
 * Stream rule inject retry (F435 / R-OMP-TTSR).
 *
 * During a streaming model response, evaluate each chunk against a set of
 * content-detection rules.  When a rule fires the chunk is a signal that the
 * model has drifted — the stream should be aborted, the rule's inject text
 * added to the retry prompt, and the turn retried.
 *
 * The inject text is a **one-off** for the retry attempt; it is never
 * permanently baked into every prompt (no permanent context tax).
 *
 * This module is a **pure advisory classifier**.  It returns a decision;
 * it never mutates mandates, permissions, budgets, or hard-limit gates.
 * The caller wires the decision into the existing retry / turn machinery
 * (composing {@link ../model/retryPolicy.js}).
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** One stream-content detection rule. */
export interface StreamRule {
  /** Regex tested against each streamed text chunk. */
  readonly pattern: RegExp;
  /**
   * Text injected into the retry prompt when this rule matches.
   * Advisory only — the caller decides whether and how to inject.
   */
  readonly inject: string;
}

const StreamRuleSchema: z.ZodType<StreamRule> = z
  .object({
    pattern: z.instanceof(RegExp),
    inject: z.string().min(1)
  })
  .strict();

/**
 * Result of evaluating stream chunks against rules.
 *
 * Every possible output is advisory.  No field in this type can alter a
 * mandate, permission, budget, or hard-limit gate — the type system enforces
 * the structural constraint.
 */
export type StreamRuleDecision =
  | {
      /** Keep streaming — no rule matched. */
      readonly action: "continue";
    }
  | {
      /** Abort the stream, inject the text, and retry the turn. */
      readonly action: "inject-retry";
      /** Joined inject texts from every matched rule (newline-separated). */
      readonly injectText: string;
      /** The rules that matched, in match order. */
      readonly matchedRules: readonly StreamRule[];
    };

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate one streamed text chunk against a rule set.
 *
 * Returns `{ action: 'continue' }` when no rule matches, or
 * `{ action: 'inject-retry', injectText, matchedRules }` when at least one
 * rule fires.  When multiple rules match, their inject texts are joined with
 * newlines in match order.
 *
 * The returned decision is purely advisory — the caller wires it into the
 * existing retry/turn loop.  This function never mutates state, never changes
 * policy, and never touches a hard limit.
 *
 * @param chunk  A text chunk from the streaming response.
 * @param rules  The rule set to test against (order matters for inject join).
 */
export function evaluate(
  chunk: string,
  rules: readonly StreamRule[]
): StreamRuleDecision {
  if (!chunk || rules.length === 0) {
    return { action: "continue" };
  }

  const matched: StreamRule[] = [];
  for (const rule of rules) {
    // Reset lastIndex so global/sticky regex work correctly across calls.
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(chunk)) {
      matched.push(rule);
    }
  }

  if (matched.length === 0) {
    return { action: "continue" };
  }

  const injectText = matched.map((r) => r.inject).join("\n");
  return { action: "inject-retry", injectText, matchedRules: matched };
}

/**
 * Accumulate chunks into a buffer, evaluating against rules as chunks arrive.
 *
 * This is the streaming-friendly accumulator: feed each chunk in and it tracks
 * the full received text.  It evaluates **each incoming chunk** (not the full
 * buffer) so a rule fires as soon as the offending pattern appears — the
 * caller can abort mid-stream without waiting for the response to finish.
 *
 * Returns the current decision after processing the chunk.  Once a rule
 * matches, subsequent chunks are still accepted (idempotent — the caller owns
 * the abort) but the decision stays `inject-retry` with the original match
 * set preserved.
 *
 * @example
 * ```ts
 * const acc = createEvaluator(rules);
 * for await (const chunk of stream) {
 *   const decision = acc(chunk);
 *   if (decision.action === 'inject-retry') {
 *     controller.abort();
 *     break;
 *   }
 * }
 * ```
 */
export function createEvaluator(
  rules: readonly StreamRule[]
): (chunk: string) => StreamRuleDecision {
  let firstMatch: StreamRuleDecision | null = null;

  return (chunk: string): StreamRuleDecision => {
    if (firstMatch !== null) {
      return firstMatch;
    }
    const decision = evaluate(chunk, rules);
    if (decision.action === "inject-retry") {
      firstMatch = decision;
    }
    return decision;
  };
}

// ── Zod schemas (runtime validation, parity with the rest of the codebase) ──

export const StreamRuleDecisionSchema: z.ZodType<StreamRuleDecision> = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("continue") }).strict(),
    z
      .object({
        action: z.literal("inject-retry"),
        injectText: z.string().min(1),
        matchedRules: z.array(StreamRuleSchema).min(1)
      })
      .strict()
  ]
);
