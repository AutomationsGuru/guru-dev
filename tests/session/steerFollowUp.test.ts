import { describe, expect, it } from "vitest";

import {
  createSteerFollowUpQueue,
  isFollowUpRequest,
  isSteerRequest,
  type FollowUpRequest,
  type SteerRequest
} from '../../src/session/steerFollowUp.js';

function times(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe("steerFollowUp — queue semantics", () => {
  it("ignores empty/whitespace-only steer and follow-up inputs", () => {
    const q = createSteerFollowUpQueue();
    q.steer("");
    q.steer("   ");
    q.followUp("\t\n");
    expect(q.queueDepth()).toBe(0);
  });

  it("trims steer and follow-up text before enqueueing", () => {
    const q = createSteerFollowUpQueue();
    q.steer("  focus on the parser  ");
    q.followUp("  write tests  ");
    expect(q.snapshot()).toEqual([
      expect.objectContaining({ kind: "steer", text: "focus on the parser" }),
      expect.objectContaining({ kind: "follow_up", text: "write tests" })
    ]);
  });

  it("steer is FIFO and does not clear follow-ups by default", () => {
    const q = createSteerFollowUpQueue();
    q.followUp("first");
    q.steer("redirect");
    q.followUp("second");

    expect(q.pendingSteerCount()).toBe(1);
    expect(q.pendingFollowUpCount()).toBe(2);

    expect(q.takeSteers().map((s) => s.text)).toEqual(["redirect"]);
    expect(q.takeFollowUps().map((f) => f.text)).toEqual(["first", "second"]);
    expect(q.queueDepth()).toBe(0);
  });

  it("followUp is FIFO and bounded independently by maxFollowUpDepth", () => {
    const dropped: string[] = [];
    const q = createSteerFollowUpQueue({ maxDepth: 5, maxFollowUpDepth: 2, onDropped: (item) => dropped.push(item.text) });

    for (const i of times(4)) {
      q.followUp(`follow-${i}`);
    }

    expect(q.pendingFollowUpCount()).toBe(2);
    expect(q.takeFollowUps().map((f) => f.text)).toEqual(["follow-2", "follow-3"]);
    expect(dropped).toEqual(["follow-0", "follow-1"]);
  });

  it("steer clears pending follow-ups when steerClearsFollowUps is enabled", () => {
    const dropped: string[] = [];
    const q = createSteerFollowUpQueue({
      steerClearsFollowUps: true,
      onDropped: (item, reason) => {
        if (reason === "steer-cleared") dropped.push(item.text);
      }
    });

    q.followUp("old task A");
    q.followUp("old task B");
    q.steer("new direction");

    expect(q.pendingFollowUpCount()).toBe(0);
    expect(q.pendingSteerCount()).toBe(1);
    expect(dropped).toEqual(["old task B", "old task A"]);
  });

  it("steer does not clear follow-ups when steerClearsFollowUps is false", () => {
    const q = createSteerFollowUpQueue({ steerClearsFollowUps: false });
    q.followUp("keep me");
    q.steer("nudge");
    expect(q.pendingFollowUpCount()).toBe(1);
    expect(q.takeFollowUps().map((f) => f.text)).toEqual(["keep me"]);
  });

  it("maxDepth bounds total steers, dropping oldest steers first", () => {
    const dropped: string[] = [];
    const q = createSteerFollowUpQueue({ maxDepth: 2, onDropped: (item) => dropped.push(item.text) });

    q.steer("a");
    q.steer("b");
    q.steer("c");

    expect(q.pendingSteerCount()).toBe(2);
    expect(q.takeSteers().map((s) => s.text)).toEqual(["b", "c"]);
    expect(dropped).toEqual(["a"]);
  });

  it("maxFollowUpDepth is capped by maxDepth", () => {
    const q = createSteerFollowUpQueue({ maxDepth: 3, maxFollowUpDepth: 100 });
    for (const i of times(5)) {
      q.followUp(`f-${i}`);
    }
    expect(q.pendingFollowUpCount()).toBe(3);
  });

  it("discardPendingSteers removes only steers and returns their texts", () => {
    const q = createSteerFollowUpQueue();
    q.steer("drop me");
    q.followUp("keep me");
    q.steer("drop me too");

    expect(q.discardPendingSteers()).toEqual(["drop me", "drop me too"]);
    expect(q.pendingSteerCount()).toBe(0);
    expect(q.pendingFollowUpCount()).toBe(1);
  });

  it("drainMidRunSteers is equivalent to takeSteers and fires onSteerInjected", () => {
    const injected: string[] = [];
    const q = createSteerFollowUpQueue({ onSteerInjected: (s) => injected.push(s.text) });
    q.steer("mid");
    q.followUp("after");

    expect(q.drainMidRunSteers().map((s) => s.text)).toEqual(["mid"]);
    expect(injected).toEqual(["mid"]);
    expect(q.pendingFollowUpCount()).toBe(1);
  });

  it("takeFollowUps fires onFollowUpTaken and leaves steers in place", () => {
    const taken: string[] = [];
    const q = createSteerFollowUpQueue({ onFollowUpTaken: (f) => taken.push(f.text) });
    q.followUp("one");
    q.steer("steer");
    q.followUp("two");

    expect(q.takeFollowUps().map((f) => f.text)).toEqual(["one", "two"]);
    expect(taken).toEqual(["one", "two"]);
    expect(q.pendingSteerCount()).toBe(1);
  });

  it("snapshot returns an immutable, oldest-first copy", () => {
    const q = createSteerFollowUpQueue();
    q.steer("first");
    q.followUp("second");

    const snap = q.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]?.text).toBe("first");
    expect(snap[1]?.text).toBe("second");

    // Mutation of the snapshot must not affect the queue.
    (snap as SteerRequest[]).push({ kind: "steer", text: "mutated", at: 0 });
    expect(q.queueDepth()).toBe(2);
  });

  it("format helpers produce expected message shapes", () => {
    const q = createSteerFollowUpQueue();
    const steer: SteerRequest = { kind: "steer", text: "focus", at: 0 };
    const followUp: FollowUpRequest = { kind: "follow_up", text: "continue", at: 0 };
    expect(q.formatSteerMessage(steer)).toBe("[steering] focus");
    expect(q.formatFollowUpMessage(followUp)).toBe("continue");
  });

  it("type guards distinguish steer and follow-up requests", () => {
    const steer: SteerRequest = { kind: "steer", text: "s", at: 0 };
    const followUp: FollowUpRequest = { kind: "follow_up", text: "f", at: 0 };
    expect(isSteerRequest(steer)).toBe(true);
    expect(isSteerRequest(followUp)).toBe(false);
    expect(isFollowUpRequest(followUp)).toBe(true);
    expect(isFollowUpRequest(steer)).toBe(false);
  });

  it("now is injectable for deterministic timestamps", () => {
    let t = 0;
    const q = createSteerFollowUpQueue({ now: () => { t += 1; return t; } });
    q.steer("a");
    q.followUp("b");
    const [first, second] = q.snapshot();
    expect(first?.at).toBe(1);
    expect(second?.at).toBe(2);
  });
});
