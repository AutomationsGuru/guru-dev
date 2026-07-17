import type { ApiSessionTimelineEvent } from "../../src/surfaces/api.js";
import {
  createApiEventStreamHub,
  type ApiEventStreamScheduler,
  type ApiEventStreamSink
} from "../../src/surfaces/apiEventStream.js";

class TestSink implements ApiEventStreamSink {
  readonly frames: string[] = [];
  readonly drainListeners = new Set<() => void>();
  readonly writeResults: boolean[] = [];
  defaultWriteResult = true;
  closeCalls = 0;
  drainCleanupCalls = 0;

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.writeResults.shift() ?? this.defaultWriteResult;
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);

    return () => {
      if (this.drainListeners.delete(listener)) {
        this.drainCleanupCalls += 1;
      }
    };
  }

  close(): void {
    this.closeCalls += 1;
  }

  drain(): void {
    for (const listener of [...this.drainListeners]) {
      listener();
    }
  }
}

class TestScheduler implements ApiEventStreamScheduler {
  readonly intervals = new Map<symbol, () => void>();
  setCalls = 0;
  clearCalls = 0;

  setInterval(callback: () => void, _intervalMs: number): unknown {
    this.setCalls += 1;
    const handle = Symbol("interval");
    this.intervals.set(handle, callback);
    return handle;
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === "symbol" && this.intervals.delete(handle)) {
      this.clearCalls += 1;
    }
  }

  fireAll(): void {
    for (const callback of [...this.intervals.values()]) {
      callback();
    }
  }
}

function timelineEvent(sessionId: string, summary: string, type: ApiSessionTimelineEvent["type"] = "run.progress"): ApiSessionTimelineEvent {
  return {
    type,
    sessionId,
    createdAt: "2026-07-15T16:00:00.000Z",
    summary,
    metadata: { marker: summary }
  };
}

function dataFrames(sink: TestSink): string[] {
  return sink.frames.filter((frame) => frame.startsWith("id: "));
}

describe("createApiEventStreamHub", () => {
  it("encodes retained events with monotonic decimal ids and one protocol-safe JSON data line", () => {
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 0 });
    const first = timelineEvent("session-one", "first\nsecond");
    const second = timelineEvent("session-two", "quoted \"value\"");

    expect(hub.publish(first).id).toBe("1");
    expect(hub.publish(second).id).toBe("2");

    const sink = new TestSink();
    const subscription = hub.subscribe({ sink });

    expect(sink.frames[0]).toBe('event: ready\ndata: {"oldestId":"1","latestId":"2"}\n\n');
    expect(dataFrames(sink)).toEqual([
      `id: 1\nevent: session.event\ndata: ${JSON.stringify({ sessionId: "session-one", event: first })}\n\n`,
      `id: 2\nevent: session.event\ndata: ${JSON.stringify({ sessionId: "session-two", event: second })}\n\n`
    ]);
    expect(dataFrames(sink)[0]?.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);

    subscription.unsubscribe();
  });

  it("filters session subscribers while preserving global publication order and exactly-once live delivery", () => {
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 0 });
    const globalSink = new TestSink();
    const sessionSink = new TestSink();
    hub.subscribe({ sink: globalSink });
    hub.subscribe({ sink: sessionSink, sessionId: "session-one" });

    const one = timelineEvent("session-one", "one");
    const two = timelineEvent("session-two", "two");
    hub.publish(one);
    hub.publish(two);

    expect(dataFrames(globalSink).map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(["1", "2"]);
    expect(dataFrames(sessionSink)).toEqual([`id: 1\nevent: session.event\ndata: ${JSON.stringify({ sessionId: "session-one", event: one })}\n\n`]);
  });

  it("replays only records newer than a valid Last-Event-ID and treats an invalid cursor as absent", () => {
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 0 });
    hub.publish(timelineEvent("session-one", "one"));
    hub.publish(timelineEvent("session-one", "two"));
    hub.publish(timelineEvent("session-one", "three"));

    const resumedSink = new TestSink();
    hub.subscribe({ sink: resumedSink, sessionId: "session-one", lastEventId: "1" });
    expect(dataFrames(resumedSink).map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(["2", "3"]);
    expect(resumedSink.frames.some((frame) => frame.startsWith("event: reset"))).toBe(false);

    const invalidSink = new TestSink();
    hub.subscribe({ sink: invalidSink, sessionId: "session-one", lastEventId: "not-a-decimal-id" });
    expect(dataFrames(invalidSink).map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(["1", "2", "3"]);
  });

  it("emits an explicit reset before replay when a valid cursor predates the bounded retained window", () => {
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 0, replayLimit: 2 });
    hub.publish(timelineEvent("session-one", "one"));
    hub.publish(timelineEvent("session-one", "two"));
    hub.publish(timelineEvent("session-one", "three"));

    const sink = new TestSink();
    hub.subscribe({ sink, sessionId: "session-one", lastEventId: "0" });

    expect(sink.frames).toEqual([
      'event: ready\ndata: {"oldestId":"2","latestId":"3"}\n\n',
      'event: reset\ndata: {"oldestId":"2","latestId":"3"}\n\n',
      expect.stringMatching(/^id: 2\n/),
      expect.stringMatching(/^id: 3\n/)
    ]);

    const freshSink = new TestSink();
    hub.subscribe({ sink: freshSink, sessionId: "session-one" });
    expect(freshSink.frames.some((frame) => frame.startsWith("event: reset"))).toBe(false);
    expect(dataFrames(freshSink).map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(["2", "3"]);
  });

  it("serializes queued writes after drain without duplicating a frame", () => {
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 0, maxPendingFrames: 2 });
    const sink = new TestSink();
    sink.writeResults.push(false, true, true);
    hub.subscribe({ sink });

    hub.publish(timelineEvent("session-one", "one"));
    hub.publish(timelineEvent("session-one", "two"));
    expect(dataFrames(sink)).toEqual([]);

    sink.drain();

    expect(dataFrames(sink).map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(["1", "2"]);
  });

  it("closes one lagging subscriber at its bounded queue without disrupting another subscriber", () => {
    const scheduler = new TestScheduler();
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 100, maxPendingFrames: 1, scheduler });
    const laggingSink = new TestSink();
    laggingSink.defaultWriteResult = false;
    const healthySink = new TestSink();
    hub.subscribe({ sink: laggingSink });
    hub.subscribe({ sink: healthySink });

    hub.publish(timelineEvent("session-one", "one"));
    hub.publish(timelineEvent("session-one", "two"));

    expect(laggingSink.closeCalls).toBe(1);
    expect(laggingSink.drainListeners.size).toBe(0);
    expect(hub.subscriberCount).toBe(1);
    expect(dataFrames(healthySink).map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(["1", "2"]);
  });

  it("bounds the pending byte queue even when the pending frame count is below its limit", () => {
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 0, maxPendingFrames: 10, maxPendingBytes: 32 });
    const sink = new TestSink();
    sink.defaultWriteResult = false;
    hub.subscribe({ sink });

    hub.publish(timelineEvent("session-one", "a payload larger than the pending byte budget"));

    expect(sink.closeCalls).toBe(1);
    expect(hub.subscriberCount).toBe(0);
  });

  it("uses injected heartbeat timing without consuming an event id or entering replay", () => {
    const scheduler = new TestScheduler();
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 50, now: () => 1234, scheduler });
    const sink = new TestSink();
    const subscription = hub.subscribe({ sink });

    scheduler.fireAll();
    expect(sink.frames.at(-1)).toBe(": heartbeat 1234\n\n");
    expect(hub.publish(timelineEvent("session-one", "one")).id).toBe("1");

    const replaySink = new TestSink();
    hub.subscribe({ sink: replaySink });
    expect(replaySink.frames).not.toContain(": heartbeat 1234\n\n");
    expect(dataFrames(replaySink)).toHaveLength(1);

    subscription.unsubscribe();
  });

  it("makes unsubscribe and hub close idempotent while removing drain listeners and timers exactly once", () => {
    const scheduler = new TestScheduler();
    const hub = createApiEventStreamHub({ heartbeatIntervalMs: 100, scheduler });
    const detachedSink = new TestSink();
    const closedSink = new TestSink();
    const detached = hub.subscribe({ sink: detachedSink });
    hub.subscribe({ sink: closedSink });

    detached.unsubscribe();
    detached.unsubscribe();
    expect(detachedSink.closeCalls).toBe(0);
    expect(detachedSink.drainCleanupCalls).toBe(1);

    hub.close();
    hub.close();
    expect(closedSink.closeCalls).toBe(1);
    expect(closedSink.drainCleanupCalls).toBe(1);
    expect(scheduler.clearCalls).toBe(2);
    expect(hub.subscriberCount).toBe(0);
  });
});
