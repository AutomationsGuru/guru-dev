import { describe, expect, it } from "vitest";

import { TurnReplayBuffer } from '../../src/session/turnReplayBuffer.js';

describe("TurnReplayBuffer", () => {
  it("keeps only the most recent K turns", () => {
    const buffer = new TurnReplayBuffer<string>(2);

    buffer.push("first");
    buffer.push("second");
    buffer.push("third");

    expect(buffer.replay()).toEqual(["second", "third"]);
  });

  it("returns a copy that cannot mutate stored turns", () => {
    const buffer = new TurnReplayBuffer<{ readonly id: string }>(2);
    buffer.push({ id: "first" });
    buffer.push({ id: "second" });

    const replay = buffer.replay();
    replay.pop();
    replay.push({ id: "third" });

    expect(buffer.replay()).toEqual([{ id: "first" }, { id: "second" }]);
  });
});
