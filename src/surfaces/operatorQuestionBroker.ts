import type { AskQuestionSpec } from "../tools/builtins/askQuestionTool.js";

// ── Error Classes ──

export class OperatorQuestionTimeoutError extends Error {
  readonly questionId: string;
  readonly sessionId: string;

  constructor(questionId: string, sessionId: string) {
    super(`Question ${questionId} timed out (session ${sessionId})`);
    this.name = "OperatorQuestionTimeoutError";
    this.questionId = questionId;
    this.sessionId = sessionId;
  }
}

export class OperatorQuestionCancelledError extends Error {
  readonly questionId: string;
  readonly sessionId: string;
  readonly reason?: string;

  constructor(questionId: string, sessionId: string, reason?: string) {
    super(
      `Question ${questionId} cancelled (session ${sessionId})${reason ? `: ${reason}` : ""}`,
    );
    this.name = "OperatorQuestionCancelledError";
    this.questionId = questionId;
    this.sessionId = sessionId;
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

export class BrokerClosedError extends Error {
  constructor() {
    super("Broker is closed");
    this.name = "BrokerClosedError";
  }
}

export class InvalidAnswerError extends Error {
  readonly questionId: string;

  constructor(questionId: string, message: string) {
    super(`Invalid answer for ${questionId}: ${message}`);
    this.name = "InvalidAnswerError";
    this.questionId = questionId;
  }
}

export class QuestionNotFoundError extends Error {
  readonly questionId: string;

  constructor(questionId: string) {
    super(`Question not found: ${questionId}`);
    this.name = "QuestionNotFoundError";
    this.questionId = questionId;
  }
}

export class QuestionAlreadySettledError extends Error {
  readonly questionId: string;

  constructor(questionId: string) {
    super(`Question already settled: ${questionId}`);
    this.name = "QuestionAlreadySettledError";
    this.questionId = questionId;
  }
}

export class BrokerOverCapacityError extends Error {
  readonly maxPending: number;

  constructor(maxPending: number) {
    super(`Broker over capacity (max pending: ${maxPending})`);
    this.name = "BrokerOverCapacityError";
    this.maxPending = maxPending;
  }
}

// ── Public Types ──

export interface PendingQuestionRecord {
  readonly questionId: string;
  readonly sessionId: string;
  readonly questions: readonly AskQuestionSpec[];
  readonly createdAt: Date;
}

export type QuestionListener = (record: PendingQuestionRecord) => void;

export interface OperatorQuestionBroker {
  ask(
    sessionId: string,
    questions: readonly AskQuestionSpec[],
    signal?: AbortSignal,
  ): Promise<string[][]>;
  answer(
    questionId: string,
    answers: string[][],
  ): { ok: true } | { ok: false; error: string };
  cancel(questionId: string): boolean;
  list(): readonly PendingQuestionRecord[];
  onQuestion(listener: QuestionListener): () => void;
  close(): void;
  readonly pendingCount: number;
  readonly closed: boolean;
}

// ── Internal ──

interface PendingEntry {
  readonly record: PendingQuestionRecord;
  resolve(answers: string[][]): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  settled: boolean;
}

// ── Validation ──

export function validateAnswers(
  questions: readonly AskQuestionSpec[],
  answers: string[][],
): string | null {
  if (!Array.isArray(answers)) {
    return "answers must be an array";
  }
  if (answers.length !== questions.length) {
    return `expected ${questions.length} answer(s), got ${answers.length}`;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const a = answers[i];
    if (a === undefined) {
      return `answer at index ${i} is undefined`;
    }
    if (!Array.isArray(a)) {
      return `answer at index ${i} must be an array of strings`;
    }
    if (!q.multiSelect && a.length > 1) {
      return `question ${i + 1} ("${q.question}") is single-select but got ${a.length} selections`;
    }
    for (const item of a) {
      if (typeof item !== "string") {
        return `answer at index ${i} contains non-string value`;
      }
      if (!q.options.includes(item)) {
        return `"${item}" is not a valid option for question ${i + 1} ("${q.question}")`;
      }
    }
  }
  return null;
}

// ── Factory ──

export interface OperatorQuestionBrokerOptions {
  readonly maxPending?: number;
  readonly defaultTimeoutMs?: number;
}

export function createOperatorQuestionBroker(
  options: OperatorQuestionBrokerOptions = {},
): OperatorQuestionBroker {
  const maxPending = options.maxPending ?? Infinity;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 0;

  const pending = new Map<string, PendingEntry>();
  const listeners = new Set<QuestionListener>();
  let closed = false;

  function notifyListeners(record: PendingQuestionRecord): void {
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // Swallow listener errors.
      }
    }
  }

  function cleanupEntry(entry: PendingEntry): void {
    if (entry.timeout !== undefined) {
      clearTimeout(entry.timeout);
    }
    if (entry.abortSignal !== undefined && entry.abortListener !== undefined) {
      entry.abortSignal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
  }

  function settleEntry(questionId: string, error: Error): void {
    const entry = pending.get(questionId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    cleanupEntry(entry);
    entry.reject(error);
    pending.delete(questionId);
  }

  const broker: OperatorQuestionBroker = {
    ask(
      sessionId: string,
      questions: readonly AskQuestionSpec[],
      signal?: AbortSignal,
    ): Promise<string[][]> {
      if (closed) {
        return Promise.reject(new BrokerClosedError());
      }

      if (pending.size >= maxPending) {
        return Promise.reject(new BrokerOverCapacityError(maxPending));
      }

      const questionId = crypto.randomUUID();
      const record: PendingQuestionRecord = {
        questionId,
        sessionId,
        questions: [...questions],
        createdAt: new Date(),
      };

      return new Promise<string[][]>((resolve, reject) => {
        // Double-check closed after creating the promise body, in case close()
        // was called synchronously between the guard above and now (defensive).
        if (closed) {
          reject(new BrokerClosedError());
          return;
        }

        const entry: PendingEntry = {
          record,
          resolve,
          reject,
          timeout: undefined,
          abortSignal: undefined,
          abortListener: undefined,
          settled: false,
        };

        if (defaultTimeoutMs > 0) {
          entry.timeout = setTimeout(() => {
            settleEntry(
              questionId,
              new OperatorQuestionTimeoutError(questionId, sessionId),
            );
          }, defaultTimeoutMs);
        }

        pending.set(questionId, entry);

        // AbortSignal integration.
        if (signal) {
          // Fast path: already aborted.
          if (signal.aborted) {
            settleEntry(
              questionId,
              new OperatorQuestionCancelledError(
                questionId,
                sessionId,
                signal.reason instanceof Error
                  ? signal.reason.message
                  : String(signal.reason ?? "aborted"),
              ),
            );
            return;
          }

          const onAbort = () => {
            settleEntry(
              questionId,
              new OperatorQuestionCancelledError(
                questionId,
                sessionId,
                signal.reason instanceof Error
                  ? signal.reason.message
                  : String(signal.reason ?? "aborted"),
              ),
            );
          };
          entry.abortSignal = signal;
          entry.abortListener = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });

          // Re-check after adding the listener to close the race window between
          // the initial aborted check and listener registration.
          if (signal.aborted) {
            settleEntry(
              questionId,
              new OperatorQuestionCancelledError(
                questionId,
                sessionId,
                signal.reason instanceof Error
                  ? signal.reason.message
                  : String(signal.reason ?? "aborted"),
              ),
            );
            return;
          }
        }

        notifyListeners(record);
      });
    },

    answer(
      questionId: string,
      answers: string[][],
    ): { ok: true } | { ok: false; error: string } {
      const entry = pending.get(questionId);
      if (!entry) {
        return { ok: false, error: `Question not found: ${questionId}` };
      }
      if (entry.settled) {
        return {
          ok: false,
          error: `Question already settled: ${questionId}`,
        };
      }

      const validationError = validateAnswers(entry.record.questions, answers);
      if (validationError !== null) {
        return { ok: false, error: validationError };
      }

      entry.settled = true;
      cleanupEntry(entry);
      entry.resolve(answers);
      pending.delete(questionId);
      return { ok: true };
    },

    cancel(questionId: string): boolean {
      const entry = pending.get(questionId);
      if (!entry || entry.settled) return false;

      entry.settled = true;
      cleanupEntry(entry);
      entry.reject(
        new OperatorQuestionCancelledError(
          questionId,
          entry.record.sessionId,
        ),
      );
      pending.delete(questionId);
      return true;
    },

    list(): readonly PendingQuestionRecord[] {
      return Array.from(pending.values(), (entry) => entry.record);
    },

    onQuestion(listener: QuestionListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      const brokerClosedError = new BrokerClosedError();
      for (const [questionId, entry] of pending) {
        if (!entry.settled) {
          entry.settled = true;
          cleanupEntry(entry);
          entry.reject(brokerClosedError);
        }
      }
      pending.clear();
    },

    get pendingCount(): number {
      return pending.size;
    },

    get closed(): boolean {
      return closed;
    },
  };

  return broker;
}
