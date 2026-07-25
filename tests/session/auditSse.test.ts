import { afterEach, describe, expect, it } from "vitest";

import {
  clearAuditEvents,
  createAuditSseStream,
  disableAuditSse,
  emitAuditEvent,
  enableAuditSse,
  getAuditEvents,
  isAuditSseEnabled,
  subscribeAuditEvents,
  subscribeAuditSse
} from '../../src/session/auditSse.js';

afterEach(() => {
  disableAuditSse();
  clearAuditEvents();
});

describe("session audit SSE", () => {
  it("is disabled by default and does not retain or publish events", () => {
    expect(isAuditSseEnabled()).toBe(false);
    expect(emitAuditEvent({ type: "intent", sessionId: "s1", metadata: { goal: "inspect" } })).toBeUndefined();
    expect(getAuditEvents()).toEqual([]);
  });

  it("requires explicit opt-in and emits intent, tool, and approval events in order", () => {
    expect(enableAuditSse()).toBe(true);
    expect(enableAuditSse()).toBe(false);

    emitAuditEvent({ type: "intent", sessionId: "s1", metadata: { goal: "inspect" } });
    emitAuditEvent({ type: "tool", sessionId: "s1", metadata: { toolId: "read" } });
    emitAuditEvent({ type: "approval", sessionId: "s1", metadata: { decision: "allow" } });

    const events = getAuditEvents();
    expect(events.map((event) => event.type)).toEqual(["intent", "tool", "approval"]);
    expect(events.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.sessionId === "s1")).toBe(true);
  });

  it("publishes only metadata and scrubs secret-shaped strings", () => {
    enableAuditSse();
    emitAuditEvent({
      type: "tool",
      sessionId: "s1",
      metadata: {
        toolId: "read",
        token: "sk-12345678901234567890",
        ignored: { secret: "not a scalar" }
      }
    });

    expect(getAuditEvents()[0]).toMatchObject({
      metadata: {
        toolId: "read",
        token: "[redacted:secret-shape]"
      }
    });
    expect(getAuditEvents()[0]?.metadata).not.toHaveProperty("ignored");
  });

  it("delivers ordered events to subscribers and isolates listener failures", () => {
    enableAuditSse();
    const received: number[] = [];
    subscribeAuditEvents(() => {
      throw new Error("listener failure");
    });
    const unsubscribe = subscribeAuditEvents((event) => received.push(event.id));

    emitAuditEvent({ type: "intent", metadata: { step: 1 } });
    emitAuditEvent({ type: "tool", metadata: { step: 2 } });
    unsubscribe();
    emitAuditEvent({ type: "approval", metadata: { step: 3 } });

    expect(received).toEqual([1, 2]);
  });

  it("formats ordered SSE frames and closes cleanly when cancelled", async () => {
    enableAuditSse();
    const stream = createAuditSseStream();
    const reader = stream.getReader();

    emitAuditEvent({ type: "approval", sessionId: "s1", metadata: { decision: "deny" } });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: expect.stringMatching(/^id: 1\nevent: audit\ndata: \{"id":1,/)
    });

    await reader.cancel();
    emitAuditEvent({ type: "intent", sessionId: "s1", metadata: { goal: "later" } });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("returns an already-closed stream while disabled", async () => {
    const reader = createAuditSseStream().getReader();
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
  });

  it("supports direct SSE frame subscriptions", () => {
    enableAuditSse();
    const frames: string[] = [];
    const unsubscribe = subscribeAuditSse((frame) => frames.push(frame));

    emitAuditEvent({ type: "intent", metadata: { goal: "inspect" } });
    unsubscribe();
    emitAuditEvent({ type: "tool", metadata: { toolId: "read" } });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: audit\n");
    expect(frames[0]).toContain('"type":"intent"');
  });
});
