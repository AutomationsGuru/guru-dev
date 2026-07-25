import { describe, expect, it } from "vitest";

import {
  compact,
  groupMessages,
  type SlidingWindowMessage
} from '../../src/memory/slidingWindowKeepGroups.js';

function msg(
  role: SlidingWindowMessage["role"],
  content: string,
  id?: string
): SlidingWindowMessage {
  return id === undefined ? { role, content } : { role, content, id };
}

describe("groupMessages — atomic conversation units", () => {
  it("isolates system messages as their own groups", () => {
    const messages = [
      msg("system", "you are guru"),
      msg("user", "hi"),
      msg("assistant", "hello")
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([messages[0]]);
    expect(groups[1]).toEqual([messages[1]]);
    expect(groups[2]).toEqual([messages[2]]);
  });

  it("keeps toolCall + toolResult together as one group", () => {
    const messages = [
      msg("user", "read file"),
      msg("assistant", "calling read"),
      msg("toolCall", "read"),
      msg("toolResult", "contents"),
      msg("user", "thanks")
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(3);
    expect(groups[1]!.map((m) => m.role)).toEqual(["assistant", "toolCall", "toolResult"]);
    expect(groups[2]!.map((m) => m.role)).toEqual(["user"]);
  });

  it("attaches role=tool results to the preceding assistant group", () => {
    const messages = [
      msg("assistant", "call"),
      msg("tool", "payload")
    ];
    expect(groupMessages(messages)).toEqual([[messages[0], messages[1]]]);
  });
});

describe("compact — keep last N non-system groups", () => {
  it("keeps only the last N non-system groups", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "u3"),
      msg("assistant", "a3")
    ];
    // 6 groups of 1; keepLast=2 → last user + last assistant
    const out = compact(messages, 2);
    expect(out.map((m) => m.content)).toEqual(["u3", "a3"]);
  });

  it("always preserves system messages while dropping older groups", () => {
    const messages = [
      msg("system", "system prompt"),
      msg("user", "old"),
      msg("assistant", "old reply"),
      msg("user", "new"),
      msg("assistant", "new reply")
    ];
    const out = compact(messages, 2);
    expect(out[0]).toEqual(messages[0]);
    expect(out.map((m) => m.content)).toEqual([
      "system prompt",
      "new",
      "new reply"
    ]);
  });

  it("preserves multiple system messages wherever they appear", () => {
    const messages = [
      msg("system", "head"),
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("system", "mid reminder"),
      msg("user", "u2"),
      msg("assistant", "a2")
    ];
    const out = compact(messages, 2);
    expect(out.map((m) => m.content)).toEqual([
      "head",
      "mid reminder",
      "u2",
      "a2"
    ]);
  });

  it("is a no-op when keepLast covers every non-system group", () => {
    const messages = [
      msg("system", "s"),
      msg("user", "u"),
      msg("assistant", "a")
    ];
    const out = compact(messages, 10);
    expect(out).toEqual(messages);
  });

  it("returns only system messages when keepLast is 0", () => {
    const messages = [
      msg("system", "s"),
      msg("user", "u"),
      msg("assistant", "a")
    ];
    expect(compact(messages, 0)).toEqual([messages[0]]);
  });

  it("returns an empty list for empty input", () => {
    expect(compact([], 5)).toEqual([]);
  });

  it("never mutates the input array or messages", () => {
    const messages = [
      msg("system", "s"),
      msg("user", "old"),
      msg("assistant", "old a"),
      msg("user", "new"),
      msg("assistant", "new a")
    ];
    const snapshot = messages.map((m) => ({ ...m }));
    compact(messages, 1);
    expect(messages).toEqual(snapshot);
  });

  it("drops whole tool-call groups atomically (never splits call from result)", () => {
    const messages = [
      msg("user", "first"),
      msg("assistant", "call-old"),
      msg("toolCall", "read"),
      msg("toolResult", "old data"),
      msg("user", "second"),
      msg("assistant", "call-new"),
      msg("toolCall", "write"),
      msg("toolResult", "new data")
    ];
    // non-system groups: [user], [assistant+toolCall+toolResult], [user], [assistant+toolCall+toolResult]
    const out = compact(messages, 2);
    expect(out.map((m) => m.content)).toEqual([
      "second",
      "call-new",
      "write",
      "new data"
    ]);
    // no orphaned toolResult from the dropped group
    expect(out.some((m) => m.content === "old data")).toBe(false);
  });

  it("clamps a negative keepLast to zero (system-only)", () => {
    const messages = [msg("system", "s"), msg("user", "u")];
    expect(compact(messages, -3)).toEqual([messages[0]]);
  });
});
