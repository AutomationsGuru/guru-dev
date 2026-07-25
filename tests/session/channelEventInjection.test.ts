import { describe, expect, it } from "vitest";
import { createChannelEventInbox, type ChannelEvent } from '../../src/session/channelEventInjection.js';

describe("ChannelEventInbox — external steer event injection", () => {
  const KNOWN_TYPES = new Set(["nudge", "alert", "route_switch"]);

  it("inject: enqueues a typed event and it appears in listPending", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    inbox.inject("nudge", { reason: "test", priority: 1 });
    const pending = inbox.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe("nudge");
    expect(pending[0]?.payload).toEqual({ reason: "test", priority: 1 });
  });

  it("pop: returns the oldest event in FIFO order and removes it", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    inbox.inject("nudge", { id: 1 });
    inbox.inject("alert", { id: 2 });
    inbox.inject("route_switch", { id: 3 });

    expect(inbox.listPending()).toHaveLength(3);

    const first = inbox.pop();
    expect(first?.type).toBe("nudge");
    expect(first?.payload).toEqual({ id: 1 });

    const second = inbox.pop();
    expect(second?.type).toBe("alert");
    expect(second?.payload).toEqual({ id: 2 });

    expect(inbox.listPending()).toHaveLength(1);

    const third = inbox.pop();
    expect(third?.type).toBe("route_switch");
    expect(third?.payload).toEqual({ id: 3 });

    expect(inbox.listPending()).toHaveLength(0);
    expect(inbox.pop()).toBeUndefined();
  });

  it("reject: throws on unknown event type", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    expect(() => inbox.inject("unknown_type", { x: 1 })).toThrow(
      /unknown.*channel.*event.*type/i
    );
    // Inbox stays clean — nothing enqueued on rejection.
    expect(inbox.listPending()).toHaveLength(0);
  });

  it("pop on empty inbox returns undefined", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    expect(inbox.pop()).toBeUndefined();
    expect(inbox.listPending()).toHaveLength(0);
  });

  it("listPending returns a snapshot — mutating the returned array does not affect the inbox", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    inbox.inject("nudge", { a: 1 });
    const snapshot = inbox.listPending();
    (snapshot as ChannelEvent[]).push({ type: "alert", payload: {} } as ChannelEvent);
    expect(inbox.listPending()).toHaveLength(1);
  });

  it("each event is stamped with an ISO timestamp", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    const before = new Date().toISOString();
    inbox.inject("nudge", { x: 1 });
    const after = new Date().toISOString();
    const event = inbox.pop();
    expect(event?.at).toBeDefined();
    expect(typeof event?.at).toBe("string");
    // The timestamp should be between before and after
    expect(event!.at >= before).toBe(true);
    expect(event!.at <= after).toBe(true);
  });

  it("reject preserves the inbox state when payload is undefined", () => {
    const inbox = createChannelEventInbox(KNOWN_TYPES);
    inbox.inject("nudge", { id: 1 });
    expect(() => inbox.inject("bogus", undefined)).toThrow();
    // The valid event is still there.
    expect(inbox.listPending()).toHaveLength(1);
    expect(inbox.pop()?.type).toBe("nudge");
  });

  it("empty known types set rejects everything", () => {
    const inbox = createChannelEventInbox(new Set());
    expect(() => inbox.inject("anything", {})).toThrow(/unknown.*channel.*event.*type/i);
    expect(inbox.listPending()).toHaveLength(0);
  });
});
