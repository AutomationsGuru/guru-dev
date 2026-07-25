import { describe, expect, it } from "vitest";

import {
  createStreamPersistenceHooks,
  replayStreamTurnText,
  STREAM_PERSISTENCE_TURN_EVENT,
  type StreamPersistenceTurnEvent
} from '../../src/session/streamPersistenceHooks.js';

describe("streamPersistenceHooks", () => {
  it("records streamed chunks as ordered turn events on flush", async () => {
    const persisted: StreamPersistenceTurnEvent[][] = [];
    const hooks = createStreamPersistenceHooks({
      persist(events) {
        persisted.push([...events]);
      }
    });

    hooks.onChunk("hel");
    hooks.onChunk("lo");
    hooks.onChunk(" world");

    const flushed = await hooks.flush();

    expect(flushed).toEqual([
      { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 1, text: "hel" },
      { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 2, text: "lo" },
      { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 3, text: " world" }
    ]);
    expect(persisted).toEqual([flushed]);
    expect(hooks.pending()).toEqual([]);
  });

  it("preserves sequence order across multiple flushes", async () => {
    const persisted: StreamPersistenceTurnEvent[] = [];
    const hooks = createStreamPersistenceHooks({
      persist(events) {
        persisted.push(...events);
      }
    });

    hooks.onChunk("a");
    await hooks.flush();
    hooks.onChunk("b");
    hooks.onChunk("c");
    await hooks.flush();

    expect(persisted.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(replayStreamTurnText(persisted)).toBe("abc");
  });

  it("ignores empty chunks and empty flushes", async () => {
    let calls = 0;
    const hooks = createStreamPersistenceHooks({
      persist() {
        calls += 1;
      }
    });

    hooks.onChunk("");

    expect(await hooks.flush()).toEqual([]);
    expect(calls).toBe(0);
  });

  it("replays text by sorting event sequence numbers", () => {
    expect(
      replayStreamTurnText([
        { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 4, text: "!" },
        { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 2, text: "llo" },
        { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 1, text: "he" },
        { type: STREAM_PERSISTENCE_TURN_EVENT, sequence: 3, text: " world" }
      ])
    ).toBe("hello world!");
  });
});
