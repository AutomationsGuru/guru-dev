/**
 * OpenInference-shaped span hooks for optional, local observability.
 *
 * This module is deliberately dependency-free and default-off. It records only
 * a small structural metadata allowlist; arbitrary attributes never cross the
 * recorder seam. A recorder is an injected sink, not a network transport.
 */

export type SpanAttribute = string | number | boolean;
export type SpanAttributes = Readonly<Record<string, unknown>>;

export interface SpanStart {
  readonly name: string;
  readonly startedAt: string;
  readonly attributes: Readonly<Record<string, SpanAttribute>>;
}

export interface SpanEnd extends SpanStart {
  readonly endedAt: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
}

export interface OpenInferenceRecorder {
  readonly onStart?: (span: SpanStart) => void;
  readonly onEnd?: (span: SpanEnd) => void;
}

export interface OpenInferenceHooksOptions {
  readonly enabled?: boolean;
  readonly now?: () => Date;
  readonly recorder?: OpenInferenceRecorder;
}

export interface SpanHooks {
  withSpan<T>(name: string, fn: () => T | Promise<T>, attributes?: SpanAttributes): T | Promise<T>;
}

/** Attribute names that describe a span without carrying request/user content. */
const METADATA_ATTRIBUTE_NAMES = new Set([
  "operation",
  "status",
  "openinference.span.kind",
  "tool.name",
  "llm.model_name",
  "turn.index",
  "session.kind"
]);

/** Key fragments that must never be recorded, even if added to the allowlist. */
const SENSITIVE_ATTRIBUTE_NAME = /(secret|password|passwd|token|api[-_]?key|apikey|authorization|credential|private[-_]?key|session[-_]?key|passphrase|prompt|input|output|content|email|phone|name|user|path|file|message)/iu;

/** Secret-shaped values are rejected before they can reach an injected sink. */
const SENSITIVE_ATTRIBUTE_VALUE: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:ghp|gho)_[A-Za-z0-9]{16,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/u
];

function isSpanAttribute(value: unknown): value is SpanAttribute {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_ATTRIBUTE_VALUE.some((pattern) => pattern.test(value));
}

/**
 * Structural metadata gate. Unknown keys, sensitive key names, non-primitives,
 * and secret-shaped strings are omitted rather than scrubbed into telemetry.
 */
export function sanitizeSpanAttributes(attributes: SpanAttributes = {}): Readonly<Record<string, SpanAttribute>> {
  const safe: Record<string, SpanAttribute> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!METADATA_ATTRIBUTE_NAMES.has(key)) {
      continue;
    }
    // The explicit metadata allowlist wins over generic fragments such as
    // `name` in `tool.name` and `llm.model_name`; user/content keys are not
    // allowlisted in the first place.
    if (!isSpanAttribute(value)) {
      continue;
    }
    if (typeof value === "string" && isSensitiveValue(value)) {
      continue;
    }
    safe[key] = value;
  }

  return safe;
}

function notify(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Observability must never become a runtime reliability dependency.
  }
}

function notifyStart(recorder: OpenInferenceRecorder | undefined, span: SpanStart): void {
  notify(() => recorder?.onStart?.(span));
}

function notifyEnd(recorder: OpenInferenceRecorder | undefined, span: SpanEnd): void {
  notify(() => recorder?.onEnd?.(span));
}

function createSpanHooks(options: OpenInferenceHooksOptions): SpanHooks {
  const enabled = options.enabled === true;
  const now = options.now ?? (() => new Date());

  return {
    withSpan<T>(
      name: string,
      fn: () => T | Promise<T>,
      attributes: SpanAttributes = {}
    ): T | Promise<T> {
      if (!enabled) {
        return fn();
      }

      const started = now();
      const start: SpanStart = {
        name,
        startedAt: started.toISOString(),
        attributes: sanitizeSpanAttributes(attributes)
      };
      notifyStart(options.recorder, start);

      const finish = (status: "ok" | "error", value?: T): T | undefined => {
        const ended = now();
        notifyEnd(options.recorder, {
          ...start,
          endedAt: ended.toISOString(),
          durationMs: Math.max(0, ended.getTime() - started.getTime()),
          status
        });
        return value;
      };

      try {
        const result = fn();
        if (result instanceof Promise) {
          return result.then(
            (value) => finish("ok", value) as T,
            (error: unknown) => {
              finish("error");
              throw error;
            }
          );
        }
        return finish("ok", result) as T;
      } catch (error: unknown) {
        finish("error");
        throw error;
      }
    }
  };
}

/** Construct an opt-in hook set. Omitting `enabled` leaves it inert. */
export function createOpenInferenceHooks(options: OpenInferenceHooksOptions = {}): SpanHooks {
  return createSpanHooks(options);
}

/** Convenience seam for callers that only need one span wrapper. */
export function withSpan<T>(
  name: string,
  fn: () => T | Promise<T>,
  options: OpenInferenceHooksOptions & { readonly attributes?: SpanAttributes } = {}
): T | Promise<T> {
  return createSpanHooks(options).withSpan(name, fn, options.attributes);
}
