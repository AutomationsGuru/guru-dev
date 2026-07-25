import { describe, expect, it } from "vitest";

import { buildSnapshot } from '../../src/fleet/fleetAgentHealth.js';

describe("buildSnapshot", () => {
  it("returns a healthy agent's current session, queue, and timestamp", () => {
    expect(
      buildSnapshot({
        sessionId: "session-123",
        status: "healthy",
        queueDepth: 2,
        updatedAt: "2026-07-20T15:42:03.000Z"
      })
    ).toEqual({
      sessionId: "session-123",
      status: "healthy",
      queueDepth: 2,
      updatedAt: "2026-07-20T15:42:03.000Z"
    });
  });

  it("retains the most recent error for an errored agent", () => {
    expect(
      buildSnapshot({
        sessionId: "session-456",
        status: "errored",
        lastError: "planner timed out",
        queueDepth: 0,
        updatedAt: "2026-07-20T15:43:00.000Z"
      })
    ).toEqual({
      sessionId: "session-456",
      status: "errored",
      lastError: "planner timed out",
      queueDepth: 0,
      updatedAt: "2026-07-20T15:43:00.000Z"
    });
  });
});
