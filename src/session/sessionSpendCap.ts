/**
 * SessionSpendCap — IDEA-F95 / R-MV-SPEND. Cumulative session spend/token caps
 * that interrupt the agent loop with an explicit receipt when usage exceeds
 * maxPriceUsd or maxTokens. Composes F49 cost honesty: when a turn reports no
 * cost, the price cap is NOT enforced (unknown cost is not free — but it is
 * also not a number), and only the token cap binds.
 *
 * Hard-limit posture (VISION §3.2): a stop decision is returned, never
 * bypassed — callers in every profile (including yolo/auto-approve) must honor
 * it. The cap itself performs no spend and prints no secrets.
 */

export interface SessionSpendCapConfig {
  /** Maximum cumulative spend in USD. Enforced only while cost is known. */
  readonly maxPriceUsd?: number;
  /** Maximum cumulative tokens (input + output) for the session. */
  readonly maxTokens?: number;
}

export interface SessionSpendUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cost of this usage in USD. Omit when the provider does not report cost. */
  readonly costUsd?: number;
}

export interface SessionSpendCapState {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Sum of reported costs. Meaningful only when `costKnown` is true. */
  readonly totalCostUsd: number;
  /** False once any usage arrived without a cost — price cap is then inert. */
  readonly costKnown: boolean;
}

export interface SessionSpendCapReceipt {
  readonly exceeded: true;
  readonly limit: "maxPriceUsd" | "maxTokens";
  readonly totalTokens: number;
  readonly maxTokens?: number;
  readonly totalCostUsd?: number;
  readonly maxPriceUsd?: number;
  readonly costKnown: boolean;
  /** Operator-facing one-line receipt, e.g. "session stopped: token cap exceeded (350/300 tokens)". */
  readonly summary: string;
}

export type SessionSpendCapDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "stop"; readonly receipt: SessionSpendCapReceipt };

export class SessionSpendCap {
  private readonly config: SessionSpendCapConfig;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalCostUsd = 0;
  private costKnown = true;

  constructor(config: SessionSpendCapConfig = {}) {
    if (config.maxPriceUsd !== undefined && !(config.maxPriceUsd >= 0)) {
      throw new Error("maxPriceUsd must be a non-negative number");
    }
    if (config.maxTokens !== undefined && !(Number.isFinite(config.maxTokens) && config.maxTokens >= 0)) {
      throw new Error("maxTokens must be a non-negative finite number");
    }
    this.config = config;
  }

  /** Accumulate usage from a turn/request. Missing cost flips the session to cost-unknown. */
  trackUsage(usage: SessionSpendUsage): void {
    this.inputTokens += Math.max(0, usage.inputTokens);
    this.outputTokens += Math.max(0, usage.outputTokens);
    if (usage.costUsd === undefined) {
      this.costKnown = false;
    } else {
      this.totalCostUsd += Math.max(0, usage.costUsd);
    }
  }

  get state(): SessionSpendCapState {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      totalCostUsd: this.totalCostUsd,
      costKnown: this.costKnown
    };
  }

  /**
   * Evaluate cumulative usage against the caps. Token cap always binds; price
   * cap binds only while every tracked usage reported a cost (F49). Once a
   * cap is exceeded the decision stays stop — cumulative usage never shrinks.
   */
  checkCap(): SessionSpendCapDecision {
    const state = this.state;
    if (this.config.maxTokens !== undefined && state.totalTokens > this.config.maxTokens) {
      return {
        kind: "stop",
        receipt: {
          exceeded: true,
          limit: "maxTokens",
          totalTokens: state.totalTokens,
          maxTokens: this.config.maxTokens,
          costKnown: state.costKnown,
          summary: `session stopped: token cap exceeded (${state.totalTokens}/${this.config.maxTokens} tokens)`
        }
      };
    }
    if (this.config.maxPriceUsd !== undefined && state.costKnown && state.totalCostUsd > this.config.maxPriceUsd) {
      return {
        kind: "stop",
        receipt: {
          exceeded: true,
          limit: "maxPriceUsd",
          totalTokens: state.totalTokens,
          totalCostUsd: state.totalCostUsd,
          maxPriceUsd: this.config.maxPriceUsd,
          costKnown: state.costKnown,
          summary: `session stopped: price cap exceeded ($${state.totalCostUsd.toFixed(6)}/$${this.config.maxPriceUsd.toFixed(6)} spent)`
        }
      };
    }
    return { kind: "continue" };
  }
}
