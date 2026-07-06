import { z } from "zod";

/**
 * Turn-loop retry policy (Runtime Survival Clusters 2+3, ADR
 * 2026-07-05-runtime-survival-retry-cancel). Pure: classification, backoff math,
 * Retry-After parsing, and a generic retry loop with injectable sleep/random —
 * the request points in agentTurn.ts wire it; tests drive it with zero real waits.
 */

export const ProviderRetryConfigSchema = z
  .object({
    /** Extra attempts granted ONLY when the provider explicitly requested retry. */
    maxRetries: z.number().int().nonnegative().max(10).default(0),
    /** Optional per-request timeout (AbortController around the fetch). */
    timeoutMs: z.number().int().positive().optional(),
    /** A server-requested delay beyond this fails IMMEDIATELY (the ceiling rule). */
    maxRetryDelayMs: z.number().int().positive().default(60_000)
  })
  .strict();

export const RetryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    baseDelayMs: z.number().int().positive().default(2_000),
    provider: ProviderRetryConfigSchema.default(() => ProviderRetryConfigSchema.parse({}))
  })
  .strict();
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

export const DEFAULT_RETRY_CONFIG: RetryConfig = RetryConfigSchema.parse({});

/** What a failed request attempt looks like to the policy. */
export interface AttemptFailure {
  /** HTTP status when the provider answered; undefined on network-level failure. */
  readonly status?: number;
  /** True when the failure never reached the provider (DNS, reset, timeout-abort). */
  readonly networkError?: boolean;
  /** Parsed Retry-After delay in ms, when the provider sent one. */
  readonly retryAfterMs?: number;
}

/**
 * The binding classification table (ADR): network failures, 408, 429, and 5xx
 * retry; every other 4xx is a REAL error and fails immediately.
 */
export function isRetryableFailure(failure: AttemptFailure): boolean {
  if (failure.networkError === true) {
    return true;
  }
  const status = failure.status;
  if (status === undefined) {
    return false;
  }
  return status === 408 || status === 429 || status >= 500;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(headerValue: string | null | undefined, now: () => number = () => Date.now()): number | undefined {
  if (headerValue === null || headerValue === undefined || headerValue.trim().length === 0) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  // Numeric (incl. fractional/negative) is ALWAYS delta-seconds — it must never
  // reach Date.parse, whose lenient V8 parser reads "0.5"/"-1" as ancient dates
  // → 0ms → zero-backoff hammering (adversarial review 2026-07-05).
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) {
    return Math.max(0, Math.round(Number.parseFloat(trimmed) * 1_000));
  }
  // HTTP-dates always carry letters (day/month names, "GMT").
  if (!/[a-z]/iu.test(trimmed)) {
    return undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - now());
}

export interface RetryDelayDecision {
  /** Wait this long, then retry. */
  readonly delayMs?: number;
  /** The server asked for more than maxRetryDelayMs — fail immediately. */
  readonly failFast?: { readonly requestedMs: number; readonly capMs: number };
}

/**
 * Delay for retry attempt `attempt` (1-based). Server-requested delays win but
 * fail fast beyond the cap; ordinary backoff is base × 2^(n−1) with 0–25%
 * jitter from the injected random source, also capped.
 */
export function computeRetryDelay(input: {
  readonly attempt: number;
  readonly config: RetryConfig;
  readonly retryAfterMs?: number;
  readonly random?: () => number;
}): RetryDelayDecision {
  const cap = input.config.provider.maxRetryDelayMs;
  if (input.retryAfterMs !== undefined) {
    if (input.retryAfterMs > cap) {
      return { failFast: { requestedMs: input.retryAfterMs, capMs: cap } };
    }
    return { delayMs: input.retryAfterMs };
  }
  const random = input.random ?? Math.random;
  const exponential = input.config.baseDelayMs * 2 ** Math.max(0, input.attempt - 1);
  const jitter = 1 + random() * 0.25;
  return { delayMs: Math.min(cap, Math.round(exponential * jitter)) };
}

/** Error thrown when a server-requested delay exceeds the fail-fast cap. */
export class RetryDelayExceededError extends Error {
  constructor(
    readonly requestedMs: number,
    readonly capMs: number
  ) {
    super(
      `Provider requested a ${Math.round(requestedMs / 1000)}s retry delay — beyond the ${Math.round(capMs / 1000)}s cap (retry.provider.maxRetryDelayMs). Failing fast instead of hanging.`
    );
    this.name = "RetryDelayExceededError";
  }
}

export interface RetryHooks {
  readonly onRetry?: (info: { readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number; readonly reason: string }) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The generic retry loop. `doAttempt` performs one request; on failure it must
 * throw an Error carrying the AttemptFailure via `describeFailure`. Budget:
 * `maxRetries` retries, plus `provider.maxRetries` extra ONLY for
 * provider-requested (Retry-After) failures. `enabled: false` = one attempt.
 */
export async function runWithRetryPolicy<T>(
  doAttempt: () => Promise<T>,
  options: {
    readonly config: RetryConfig;
    readonly describeFailure: (error: unknown) => AttemptFailure;
    readonly hooks?: RetryHooks;
  }
): Promise<T> {
  const { config } = options;
  const sleep = options.hooks?.sleep ?? defaultSleep;
  let attempt = 0;
  let providerExtraUsed = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await doAttempt();
    } catch (error) {
      if (!config.enabled) {
        throw error;
      }
      const failure = options.describeFailure(error);
      if (!isRetryableFailure(failure)) {
        throw error;
      }
      const providerRequested = failure.retryAfterMs !== undefined;
      attempt += 1;
      const baseBudget = config.maxRetries;
      const withinBase = attempt <= baseBudget;
      const withinProviderExtra = providerRequested && providerExtraUsed < config.provider.maxRetries;
      if (!withinBase && !withinProviderExtra) {
        throw error;
      }
      if (!withinBase && withinProviderExtra) {
        providerExtraUsed += 1;
      }
      const decision = computeRetryDelay({
        attempt,
        config,
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
        ...(options.hooks?.random ? { random: options.hooks.random } : {})
      });
      if (decision.failFast) {
        throw new RetryDelayExceededError(decision.failFast.requestedMs, decision.failFast.capMs);
      }
      const delayMs = decision.delayMs ?? config.baseDelayMs;
      options.hooks?.onRetry?.({
        attempt,
        // The ceiling actually in force: provider extras exist only for
        // provider-requested (Retry-After) failures (CodeRabbit 2026-07-05).
        maxAttempts: providerRequested ? baseBudget + config.provider.maxRetries : baseBudget,
        delayMs,
        reason:
          failure.networkError === true
            ? "network error"
            : failure.status !== undefined
              ? `HTTP ${failure.status}`
              : "transient failure"
      });
      await sleep(delayMs);
    }
  }
}
