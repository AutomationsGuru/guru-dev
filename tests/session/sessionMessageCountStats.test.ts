import { describe, expect, it } from "vitest";

import { sessionMessageCountStats } from '../../src/session/sessionMessageCountStats.js';
import type { ChatTurnMessage } from '../../src/model/directChat.js';

describe("sessionMessageCountStats", () => {
  it("returns zeros for an empty history", () => {
    expect(sessionMessageCountStats([])).toEqual({ messages: 0, turns: 0, groups: 0 });
  });

  it("counts a single user/assistant exchange as one turn in one group", () => {
    const history: ChatTurnMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];
    expect(sessionMessageCountStats(history)).toEqual({ messages: 2, turns: 1, groups: 1 });
  });

  it("excludes the system head from messages, turns, and groups", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "you are a harness" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ];
    expect(sessionMessageCountStats(history)).toEqual({ messages: 2, turns: 1, groups: 1 });
  });

  it("counts each user message as a turn across multi-turn history", () => {
    const history: ChatTurnMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" }
    ];
    expect(sessionMessageCountStats(history)).toEqual({ messages: 6, turns: 3, groups: 1 });
  });

  it("counts mid-history system messages (steering / compaction summaries) as group boundaries", () => {
    const history: ChatTurnMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "system", content: "[steering] focus on tests" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "system", content: "[summary]\nfolded earlier context" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" }
    ];
    // Mid-history system messages are not transcript messages (they are
    // excluded like the head) and not turns; each one starts a new group.
    expect(sessionMessageCountStats(history)).toEqual({ messages: 6, turns: 3, groups: 3 });
  });

  it("excludes every system message (head and later summaries) from the message count", () => {
    const history: ChatTurnMessage[] = [
      { role: "system", content: "head" },
      { role: "system", content: "[summary]\nfolded" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" }
    ];
    expect(sessionMessageCountStats(history)).toEqual({ messages: 2, turns: 1, groups: 1 });
  });

  it("returns zero groups when only a system head exists", () => {
    const history: ChatTurnMessage[] = [{ role: "system", content: "head only" }];
    expect(sessionMessageCountStats(history)).toEqual({ messages: 0, turns: 0, groups: 0 });
  });
});
