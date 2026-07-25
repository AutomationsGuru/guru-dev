import { describe, expect, it } from "vitest";

import {
  onComplete,
  onNodeComplete,
  SWARM_NODE_EVENT_CAPACITY,
  type SwarmNodeEvent
} from '../../src/swarm/swarmNodeObservabilityHook.js';

describe("swarm node observability hook", () => {
  it("records a completed node event without mutating the input history", () => {
    const existing: readonly SwarmNodeEvent[] = [{ nodeId: "first" }];

    const recorded = onComplete(existing, "second");

    expect(recorded).toEqual([{ nodeId: "first" }, { nodeId: "second" }]);
    expect(recorded).not.toBe(existing);
    expect(existing).toEqual([{ nodeId: "first" }]);
    expect(onNodeComplete(existing, "third")).toEqual([{ nodeId: "first" }, { nodeId: "third" }]);
  });

  it("evicts the oldest event while retaining the newest bounded history", () => {
    const events: readonly SwarmNodeEvent[] = Array.from(
      { length: SWARM_NODE_EVENT_CAPACITY },
      (_, index) => ({ nodeId: `node-${index}` })
    );

    const recorded = onComplete(events, "newest");

    expect(recorded).toHaveLength(SWARM_NODE_EVENT_CAPACITY);
    expect(recorded[0]).toEqual({ nodeId: "node-1" });
    expect(recorded.at(-1)).toEqual({ nodeId: "newest" });
    expect(events[0]).toEqual({ nodeId: "node-0" });
  });
});
