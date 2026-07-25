import { describe, expect, it } from "vitest";

import { createSkillEventTriggerBus } from '../../src/skills/skillEventTriggerBus.js';

describe("createSkillEventTriggerBus", () => {
  it("dispatches the skill ids registered for an event", () => {
    const bus = createSkillEventTriggerBus();
    bus.on("turn:start", "summarize-context");
    bus.on("turn:start", "suggest-next-step");
    bus.on("turn:end", "record-learning");

    expect(bus.dispatch("turn:start")).toEqual(["summarize-context", "suggest-next-step"]);
    expect(bus.dispatch("turn:end")).toEqual(["record-learning"]);
  });

  it("returns no skill ids for an unknown event", () => {
    const bus = createSkillEventTriggerBus();

    expect(bus.dispatch("tool:result")).toEqual([]);
  });
});
