import { describe, expect, it } from "vitest";

import { createBackgroundRunRegistry } from '../../src/swarm/backgroundRunRegistry.js';

describe("background subagent run registry", () => {
  it("assigns a unique run id to each started session", () => {
    const registry = createBackgroundRunRegistry();

    const first = registry.start("session-1");
    const second = registry.start("session-1");

    expect(first).toMatchObject({ sessionId: "session-1", status: "running" });
    expect(second).toMatchObject({ sessionId: "session-1", status: "running" });
    expect(first.runId).not.toBe(second.runId);
  });

  it("registers externally assigned run ids and tracks terminal transitions", () => {
    const registry = createBackgroundRunRegistry();
    const registered = registry.register("run-external", "session-2");

    expect(registered).toMatchObject({ runId: "run-external", sessionId: "session-2", status: "running" });
    expect(registry.complete(registered.runId)).toMatchObject({ status: "done" });
    expect(registry.get(registered.runId)).toMatchObject({ status: "done" });

    const failed = registry.start("session-3");
    expect(registry.fail(failed.runId)).toMatchObject({ status: "failed" });
    expect(registry.get(failed.runId)).toMatchObject({ sessionId: "session-3", status: "failed" });
  });
});
