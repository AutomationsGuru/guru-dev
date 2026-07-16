import {
  createOperatorQuestionBroker,
  OperatorQuestionTimeoutError,
  OperatorQuestionCancelledError,
  BrokerClosedError,
  BrokerOverCapacityError,
  type OperatorQuestionBroker,
  type PendingQuestionRecord,
} from "../../src/surfaces/operatorQuestionBroker.js";
import type { AskQuestionSpec } from "../../src/tools/builtins/askQuestionTool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function single(q: string, options: string[] = ["a", "b", "c"]): AskQuestionSpec {
  return { question: q, options, multiSelect: false };
}

function multi(q: string, options: string[] = ["x", "y", "z"]): AskQuestionSpec {
  return { question: q, options, multiSelect: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OperatorQuestionBroker", () => {
  let broker: OperatorQuestionBroker;

  beforeEach(() => {
    broker = createOperatorQuestionBroker();
  });

  afterEach(() => {
    broker.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Construction (2 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("construction", () => {
    it("has pendingCount=0 and closed=false after creation", () => {
      expect(broker.pendingCount).toBe(0);
      expect(broker.closed).toBe(false);
    });

    it("respects custom maxPending", () => {
      const capped = createOperatorQuestionBroker({ maxPending: 5 });
      expect(capped.pendingCount).toBe(0);
      expect(capped.closed).toBe(false);
      capped.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Recovery ask → answer (5 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("ask then answer", () => {
    it("resolves a single-select question", async () => {
      const questions: AskQuestionSpec[] = [single("pick one")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();
      expect(records).toHaveLength(1);
      expect(records[0]!.questions[0]!.multiSelect).toBe(false);

      const result = broker.answer(records[0]!.questionId, [["a"]]);
      expect(result).toEqual({ ok: true });

      const answers = await promise;
      expect(answers).toEqual([["a"]]);
      expect(broker.pendingCount).toBe(0);
    });

    it("resolves a multi-select question", async () => {
      const questions: AskQuestionSpec[] = [multi("pick many")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [["x", "z"]]);
      expect(result).toEqual({ ok: true });

      const answers = await promise;
      expect(answers).toEqual([["x", "z"]]);
    });

    it("resolves with empty answers array for multi-select", async () => {
      const questions: AskQuestionSpec[] = [multi("optional picks")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [[]]);
      expect(result).toEqual({ ok: true });

      const answers = await promise;
      expect(answers).toEqual([[]]);
    });

    it("keeps two sessions isolated", async () => {
      const p1 = broker.ask("session-A", [single("A?")]);
      const p2 = broker.ask("session-B", [single("B?")]);

      const records = broker.list();
      expect(records).toHaveLength(2);

      // Answer session A — use an option from the default options list
      const recA = records.find((r) => r.sessionId === "session-A")!;
      expect(broker.answer(recA.questionId, [["a"]])).toEqual({ ok: true });
      const ansA = await p1;
      expect(ansA).toEqual([["a"]]);

      // Session B still pending
      expect(broker.pendingCount).toBe(1);

      const recB = records.find((r) => r.sessionId === "session-B")!;
      expect(broker.answer(recB.questionId, [["b"]])).toEqual({ ok: true });
      const ansB = await p2;
      expect(ansB).toEqual([["b"]]);

      expect(broker.pendingCount).toBe(0);
    });

    it("answers questions in reverse order", async () => {
      const p1 = broker.ask("s1", [single("first")]);
      const p2 = broker.ask("s1", [single("second")]);

      const records = broker.list();
      expect(records).toHaveLength(2);

      // Answer the second question first
      expect(broker.answer(records[1]!.questionId, [["b"]])).toEqual({ ok: true });
      const ans2 = await p2;
      expect(ans2).toEqual([["b"]]);

      // Then the first
      expect(broker.answer(records[0]!.questionId, [["a"]])).toEqual({ ok: true });
      const ans1 = await p1;
      expect(ans1).toEqual([["a"]]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. onQuestion (3 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("onQuestion", () => {
    it("fires listener on ask", async () => {
      const fired: PendingQuestionRecord[] = [];
      broker.onQuestion((rec) => fired.push(rec));

      const questions: AskQuestionSpec[] = [single("q")];
      const promise = broker.ask("s1", questions);

      // Flush microtasks so the listener fires
      await Promise.resolve();

      expect(fired).toHaveLength(1);
      expect(fired[0]!.sessionId).toBe("s1");
      expect(fired[0]!.questions[0]!.question).toBe("q");

      // Clean up
      const records = broker.list();
      broker.answer(records[0]!.questionId, [["a"]]);
      await promise;
    });

    it("stops firing after unsubscribe", async () => {
      const fired: PendingQuestionRecord[] = [];
      const unsub = broker.onQuestion((rec) => fired.push(rec));

      const p1 = broker.ask("s1", [single("q1")]);
      await Promise.resolve();
      expect(fired).toHaveLength(1);

      unsub();

      const p2 = broker.ask("s1", [single("q2")]);
      await Promise.resolve();
      expect(fired).toHaveLength(1); // still 1

      // Clean up both
      const records = broker.list();
      for (const r of records) {
        broker.answer(r.questionId, [["a"]]);
      }
      await Promise.all([p1, p2]);
    });

    it("swallows errors thrown by listeners", async () => {
      broker.onQuestion(() => {
        throw new Error("boom");
      });
      const fired: PendingQuestionRecord[] = [];
      broker.onQuestion((rec) => fired.push(rec));

      const promise = broker.ask("s1", [single("q")]);
      await Promise.resolve();

      // Second listener should still have fired despite first throwing
      expect(fired).toHaveLength(1);

      // Clean up
      const records = broker.list();
      broker.answer(records[0]!.questionId, [["a"]]);
      await promise;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Answer validation failures (6 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("answer validation failures", () => {
    it("rejects value not in options (single-select)", async () => {
      const questions: AskQuestionSpec[] = [single("pick", ["a", "b"])];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [["z"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "not a valid option",
      );

      // Question still pending; fix with a valid answer
      expect(broker.pendingCount).toBe(1);
      expect(broker.answer(records[0]!.questionId, [["a"]])).toEqual({ ok: true });
      await expect(promise).resolves.toEqual([["a"]]);
    });

    it("rejects value not in options (multi-select)", async () => {
      const questions: AskQuestionSpec[] = [multi("pick", ["x", "y"])];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [["x", "z"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "not a valid option",
      );

      // Clean up
      broker.answer(records[0]!.questionId, [["x"]]);
      await promise;
    });

    it("rejects >1 value for single-select", async () => {
      const questions: AskQuestionSpec[] = [single("pick one", ["a", "b"])];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [["a", "b"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "single-select but got 2 selections",
      );

      // Clean up
      broker.answer(records[0]!.questionId, [["a"]]);
      await promise;
    });

    it("allows duplicate values in multi-select answers (validation does not deduplicate)", async () => {
      // validateAnswers checks each item against options but does not
      // reject duplicates. This test codifies the current behavior.
      const questions: AskQuestionSpec[] = [multi("pick", ["x", "y"])];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [["x", "x"]]);
      expect(result).toEqual({ ok: true });

      const answers = await promise;
      expect(answers).toEqual([["x", "x"]]);
    });

    it("rejects wrong answer count", async () => {
      const questions: AskQuestionSpec[] = [single("q1"), single("q2")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, [["a"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "expected 2 answer(s), got 1",
      );

      // Clean up with correct count
      broker.answer(records[0]!.questionId, [["a"], ["b"]]);
      await promise;
    });

    it("rejects non-array answers", async () => {
      const questions: AskQuestionSpec[] = [single("q")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      const result = broker.answer(records[0]!.questionId, null as unknown as string[][]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toBe(
        "answers must be an array",
      );

      // Clean up
      broker.answer(records[0]!.questionId, [["a"]]);
      await promise;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Unknown / already-settled (5 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("unknown / already-settled", () => {
    it("returns error for unknown questionId", () => {
      const result = broker.answer("nonexistent", [["a"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "Question not found",
      );
    });

    it("returns error on double-answer (entry already deleted after first resolve)", async () => {
      const questions: AskQuestionSpec[] = [single("q")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      // First answer succeeds, deletes the entry
      expect(broker.answer(records[0]!.questionId, [["a"]])).toEqual({ ok: true });
      await promise;

      // Second answer — entry has been deleted by resolve, so "not found"
      const result = broker.answer(records[0]!.questionId, [["b"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "Question not found",
      );
    });

    it("returns error on answer for cancelled question (entry deleted after cancel)", async () => {
      const questions: AskQuestionSpec[] = [single("q")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      expect(broker.cancel(records[0]!.questionId)).toBe(true);
      // Swallow the cancellation rejection
      await promise.catch(() => {});

      // Entry deleted by cancel, so answer returns "not found"
      const result = broker.answer(records[0]!.questionId, [["a"]]);
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toContain(
        "Question not found",
      );
    });

    it("returns false for cancel on unknown questionId", () => {
      expect(broker.cancel("nonexistent")).toBe(false);
    });

    it("returns false for cancel after answer resolves", async () => {
      const questions: AskQuestionSpec[] = [single("q")];
      const promise = broker.ask("s1", questions);
      const records = broker.list();

      expect(broker.answer(records[0]!.questionId, [["a"]])).toEqual({ ok: true });
      await promise;

      // Entry deleted after resolve, cancel should return false
      expect(broker.cancel(records[0]!.questionId)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Timeout (2 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("timeout", () => {
    it("rejects after defaultTimeoutMs", async () => {
      const timed = createOperatorQuestionBroker({ defaultTimeoutMs: 50 });
      try {
        const promise = timed.ask("s1", [single("q")]);

        await expect(promise).rejects.toThrow(OperatorQuestionTimeoutError);
        await expect(promise).rejects.toMatchObject({
          questionId: expect.any(String) as string,
          sessionId: "s1",
        });
      } finally {
        timed.close();
      }
    });

    it("carries questionId and sessionId on timeout error", async () => {
      const timed = createOperatorQuestionBroker({ defaultTimeoutMs: 50 });
      try {
        const promise = timed.ask("timeout-session", [single("q")]);

        let caught: OperatorQuestionTimeoutError | null = null;
        try {
          await promise;
        } catch (e) {
          caught = e as OperatorQuestionTimeoutError;
        }

        expect(caught).toBeInstanceOf(OperatorQuestionTimeoutError);
        expect(caught!.questionId).toBeTruthy();
        expect(caught!.sessionId).toBe("timeout-session");
      } finally {
        timed.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Explicit cancel (2 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("explicit cancel", () => {
    it("rejects the promise with OperatorQuestionCancelledError", async () => {
      const promise = broker.ask("s1", [single("q")]);
      const records = broker.list();

      const cancelled = broker.cancel(records[0]!.questionId);
      expect(cancelled).toBe(true);

      await expect(promise).rejects.toThrow(OperatorQuestionCancelledError);
    });

    it("carries questionId and sessionId on cancel error", async () => {
      const promise = broker.ask("cancel-session", [single("q")]);
      const records = broker.list();

      broker.cancel(records[0]!.questionId);

      let caught: OperatorQuestionCancelledError | null = null;
      try {
        await promise;
      } catch (e) {
        caught = e as OperatorQuestionCancelledError;
      }

      expect(caught).toBeInstanceOf(OperatorQuestionCancelledError);
      expect(caught!.questionId).toBeTruthy();
      expect(caught!.sessionId).toBe("cancel-session");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. AbortSignal (5 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("AbortSignal", () => {
    it("already-aborted signal rejects immediately", async () => {
      const controller = new AbortController();
      controller.abort();

      const promise = broker.ask("s1", [single("q")], controller.signal);

      await expect(promise).rejects.toThrow(OperatorQuestionCancelledError);
      expect(broker.pendingCount).toBe(0);
    });

    it("mid-wait abort rejects the promise", async () => {
      const controller = new AbortController();
      const promise = broker.ask("s1", [single("q")], controller.signal);
      expect(broker.pendingCount).toBe(1);

      controller.abort();

      await expect(promise).rejects.toThrow(OperatorQuestionCancelledError);
      expect(broker.pendingCount).toBe(0);
    });

    it("removes the abort listener after a successful answer", async () => {
      const controller = new AbortController();
      const addEventListener = vi.spyOn(
        controller.signal,
        "addEventListener",
      );
      const removeEventListener = vi.spyOn(
        controller.signal,
        "removeEventListener",
      );
      const promise = broker.ask("s1", [single("q")], controller.signal);
      const abortListener = addEventListener.mock.calls[0]![1];
      const record = broker.list()[0]!;

      expect(broker.answer(record.questionId, [["a"]])).toEqual({ ok: true });
      await expect(promise).resolves.toEqual([["a"]]);

      expect(removeEventListener).toHaveBeenCalledTimes(1);
      expect(removeEventListener).toHaveBeenCalledWith("abort", abortListener);
    });

    it("removes the abort listener after explicit cancel", async () => {
      const controller = new AbortController();
      const addEventListener = vi.spyOn(
        controller.signal,
        "addEventListener",
      );
      const removeEventListener = vi.spyOn(
        controller.signal,
        "removeEventListener",
      );
      const promise = broker.ask("s1", [single("q")], controller.signal);
      const abortListener = addEventListener.mock.calls[0]![1];
      const record = broker.list()[0]!;

      expect(broker.cancel(record.questionId)).toBe(true);
      await expect(promise).rejects.toThrow(OperatorQuestionCancelledError);

      expect(removeEventListener).toHaveBeenCalledTimes(1);
      expect(removeEventListener).toHaveBeenCalledWith("abort", abortListener);
    });

    it("removes the abort listener after timeout", async () => {
      const timed = createOperatorQuestionBroker({ defaultTimeoutMs: 10 });
      const controller = new AbortController();
      const addEventListener = vi.spyOn(
        controller.signal,
        "addEventListener",
      );
      const removeEventListener = vi.spyOn(
        controller.signal,
        "removeEventListener",
      );
      const promise = timed.ask("s1", [single("q")], controller.signal);
      const abortListener = addEventListener.mock.calls[0]![1];

      try {
        await expect(promise).rejects.toThrow(OperatorQuestionTimeoutError);
        expect(removeEventListener).toHaveBeenCalledTimes(1);
        expect(removeEventListener).toHaveBeenCalledWith(
          "abort",
          abortListener,
        );
      } finally {
        timed.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Broker close (3 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("broker close", () => {
    it("rejects new asks after close", async () => {
      broker.close();
      expect(broker.closed).toBe(true);

      await expect(broker.ask("s1", [single("q")])).rejects.toThrow(
        BrokerClosedError,
      );
    });

    it("rejects all pending promises on close", async () => {
      const p1 = broker.ask("s1", [single("q1")]);
      const p2 = broker.ask("s2", [single("q2")]);

      broker.close();

      await expect(p1).rejects.toThrow(BrokerClosedError);
      await expect(p2).rejects.toThrow(BrokerClosedError);
      expect(broker.pendingCount).toBe(0);
    });

    it("close is idempotent", () => {
      broker.close();
      expect(broker.closed).toBe(true);
      // Second close should not throw
      expect(() => broker.close()).not.toThrow();
      expect(broker.closed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Overflow (2 tests)
  // ═══════════════════════════════════════════════════════════════════════

  describe("overflow", () => {
    it("rejects new asks when at capacity", async () => {
      const capped = createOperatorQuestionBroker({ maxPending: 1 });
      try {
        // Fill the single slot
        const p1 = capped.ask("s1", [single("q1")]);
        expect(capped.pendingCount).toBe(1);

        await expect(capped.ask("s2", [single("q2")])).rejects.toThrow(
          BrokerOverCapacityError,
        );

        // Clean up the first
        const records = capped.list();
        capped.answer(records[0]!.questionId, [["a"]]);
        await p1;
      } finally {
        capped.close();
      }
    });

    it("frees capacity after a question is resolved", async () => {
      const capped = createOperatorQuestionBroker({ maxPending: 1 });
      try {
        const p1 = capped.ask("s1", [single("q1")]);
        expect(capped.pendingCount).toBe(1);

        // Can't add another while full
        await expect(capped.ask("s2", [single("q2")])).rejects.toThrow(
          BrokerOverCapacityError,
        );

        // Resolve the first, freeing capacity
        const records = capped.list();
        capped.answer(records[0]!.questionId, [["a"]]);
        await p1;
        expect(capped.pendingCount).toBe(0);

        // Now a new ask should succeed
        const p2 = capped.ask("s3", [single("q3")]);
        expect(capped.pendingCount).toBe(1);
        const records2 = capped.list();
        capped.answer(records2[0]!.questionId, [["b"]]);
        await p2;
      } finally {
        capped.close();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Cross-session (1 test)
  // ═══════════════════════════════════════════════════════════════════════

  describe("cross-session", () => {
    it("generates different questionIds and does not cross-deliver", async () => {
      const p1 = broker.ask("session-A", [single("A?")]);
      const p2 = broker.ask("session-B", [single("B?")]);

      const records = broker.list();
      expect(records).toHaveLength(2);
      expect(records[0]!.questionId).not.toBe(records[1]!.questionId);
      expect(records[0]!.sessionId).not.toBe(records[1]!.sessionId);

      // Answer session A's question
      const recA = records.find((r) => r.sessionId === "session-A")!;
      broker.answer(recA.questionId, [["a"]]);
      const ansA = await p1;
      expect(ansA).toEqual([["a"]]);

      // Session B still pending
      expect(broker.pendingCount).toBe(1);

      // Attempting to answer with A's (now-settled) questionId fails
      const result = broker.answer(recA.questionId, [["b"]]);
      expect(result.ok).toBe(false);

      // Answer B with its own ID
      const recB = records.find((r) => r.sessionId === "session-B")!;
      broker.answer(recB.questionId, [["b"]]);
      const ansB = await p2;
      expect(ansB).toEqual([["b"]]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. List snapshot (1 test)
  // ═══════════════════════════════════════════════════════════════════════

  describe("list snapshot", () => {
    it("returns a mutation-safe snapshot", async () => {
      const p1 = broker.ask("s1", [single("q1")]);
      const p2 = broker.ask("s2", [single("q2")]);

      const snapshot = broker.list();
      expect(snapshot).toHaveLength(2);

      // Mutating the returned array should not affect internal state
      (snapshot as PendingQuestionRecord[]).splice(0, snapshot.length);
      expect(broker.list()).toHaveLength(2);
      expect(broker.pendingCount).toBe(2);

      // Clean up
      const records = broker.list();
      for (const r of records) {
        broker.answer(r.questionId, [["a"]]);
      }
      await Promise.all([p1, p2]);
    });
  });
});
