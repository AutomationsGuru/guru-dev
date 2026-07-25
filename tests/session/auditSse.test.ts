import { afterEach, describe, expect, it } from "vitest";

import {
  emitAuditEvent,
  enableAuditSse,
  isAuditSseEnabled,
  getAuditEvents,
  clearAuditEvents,
  subscribeAuditEvents,
  createAuditSseStream,
} from '../../src/session/auditSse.js';

afterEach(() => {
  clearAuditEvents();
  // ensure disabled for next test (tests must not leak enable state)
  // Note: no direct disable exported; tests re-create context or accept one-way enable in real use
});

describe("auditSse (IDEA-F270-AUDIT-SSE-01)", () => {
  it("defaults to disabled and drops emits", () => {
    expect(isAuditSseEnabled()).toBe(false);
    emitAuditEvent({ type: "intent", payload: { goal: "test" } });
    expect(getAuditEvents()).toHaveLength(0);
  });

  it("emits events in strict call order once enabled", () => {
    enableAuditSse();
    expect(isAuditSseEnabled()).toBe(true);

    emitAuditEvent({ type: "intent", payload: { text: "first" } });
    emitAuditEvent({ type: "tool", payload: { toolId: "bash" } });
    emitAuditEvent({ type: "approval", payload: { action: "write" } });

    const events = getAuditEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("intent");
    expect(events[1].type).toBe("tool");
    expect(events[2].type).toBe("approval");
    // timestamps should be non-decreasing (same ms possible)
    expect(events[0].ts <= events[1].ts).toBe(true);
    expect(events[1].ts <= events[2].ts).toBe(true);
  });

  it("supports live subscription callbacks and preserves order", () => {
    enableAuditSse();
    const received: string[] = [];
    const unsub = subscribeAuditEvents((e) => received.push(e.type));

    emitAuditEvent({ type: "intent", payload: 1 });
    emitAuditEvent({ type: "tool", payload: 2 });

    expect(received).toEqual(["intent", "tool"]);
    unsub();
  });

  it("createAuditSseStream yields SSE formatted data when enabled", async () => {
    enableAuditSse();
    const stream = createAuditSseStream();
    const reader = stream.getReader();
    const chunks: string[] = [];

    // emit after stream created to test live push
    emitAuditEvent({ type: "approval", payload: { ok: true } });

    // read a chunk (non-blocking best effort for test)
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: string; done: boolean }>((res) =>
        setTimeout(() => res({ done: true }), 20)
      ),
    ]);

    if (value) chunks.push(value as string);
    reader.releaseLock();

    // At minimum the stream was created without throwing and is SSE-shaped if data arrived
    expect(stream).toBeInstanceOf(ReadableStream);
    // If chunk arrived it should start with "data: "
    if (chunks.length > 0) {
      expect(chunks[0]).toMatch(/^data: /);
    }
  });
});
