import { describe, it, expect } from "vitest";

import {
  CHANNEL_MARKER_PREFIX,
  isChannelMarker,
  preserveChannelMarkers
} from "../../src/session/compactChannelMarkers.js";
import type { ChatTurnMessage } from "../../src/model/directChat.js";

function sys(content: string): ChatTurnMessage {
  return { role: "system", content };
}
function user(content: string): ChatTurnMessage {
  return { role: "user", content };
}
function assistant(content: string): ChatTurnMessage {
  return { role: "assistant", content };
}
function marker(name: string, body = ""): ChatTurnMessage {
  const content = body.length > 0 ? `${CHANNEL_MARKER_PREFIX} ${name}] ${body}` : `${CHANNEL_MARKER_PREFIX} ${name}]`;
  return sys(content);
}
function compactionSummary(count = 1): ChatTurnMessage {
  return sys(`[compaction summary] (${count} compaction${count === 1 ? "" : "s"}; ~500 tok folded)\nThe operator asked about file structure.`);
}

describe("isChannelMarker", () => {
  it("identifies a system message with the channel marker prefix", () => {
    expect(isChannelMarker(sys("[channel marker: git-log]"))).toBe(true);
    expect(isChannelMarker(marker("task-start", "Building compaction engine"))).toBe(true);
  });

  it("rejects a user/assistant message starting with the prefix", () => {
    expect(isChannelMarker(user("[channel marker: test]"))).toBe(false);
    expect(isChannelMarker(assistant("[channel marker: test]"))).toBe(false);
  });

  it("rejects a system message without the prefix", () => {
    expect(isChannelMarker(sys("This is a regular system prompt"))).toBe(false);
    expect(isChannelMarker(sys("[compaction summary] something"))).toBe(false);
  });

  it("rejects an empty system message", () => {
    expect(isChannelMarker(sys(""))).toBe(false);
  });
});

describe("preserveChannelMarkers", () => {
  it("passes through when there are no markers in the before transcript", () => {
    const before = [sys("system prompt"), user("hello"), assistant("hi there")];
    const after = [compactionSummary(), user("hello"), assistant("hi there")];
    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual(after);
    // distinct array (no mutation of input)
    expect(result).not.toBe(after);
  });

  it("passes through when all markers from before are already in after", () => {
    const m = marker("task-start");
    const before = [sys("prompt"), m, user("hello"), assistant("hi")];
    const after = [compactionSummary(), m, user("hello"), assistant("hi")];
    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual(after);
  });

  it("reattaches a single missing marker after the compaction summary", () => {
    const m = marker("task-start");
    const before = [sys("prompt"), m, user("hello"), assistant("hi")];
    const after = [compactionSummary(), user("hello"), assistant("hi")];
    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual([compactionSummary(), m, user("hello"), assistant("hi")]);
  });

  it("reattaches multiple missing markers in order", () => {
    const m1 = marker("task-start", "begin work");
    const m2 = marker("checkpoint", "halfway");
    const m3 = marker("task-end", "done");

    const before = [sys("prompt"), m1, user("hello"), m2, assistant("ok"), m3];
    const after = [compactionSummary(), user("last message"), assistant("response")];

    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual([
      compactionSummary(),
      m1,
      m2,
      m3,
      user("last message"),
      assistant("response")
    ]);
  });

  it("reattaches markers at end when no compaction summary is present", () => {
    const m = marker("task-start");
    const before = [sys("prompt"), m, user("hello"), assistant("hi")];
    const after = [sys("system head"), user("hello"), assistant("hi")];

    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual([sys("system head"), user("hello"), assistant("hi"), m]);
  });

  it("does not duplicate markers that appear in the kept region", () => {
    const m1 = marker("task-start");
    const m2 = marker("checkpoint");

    const before = [m1, user("early"), m2, assistant("early-response"), user("later")];
    // m2 was in the "kept" region and survived verbatim
    const after = [compactionSummary(), m2, user("later"), assistant("response")];

    const result = preserveChannelMarkers(before, after);
    // Only m1 should be reattached; m2 is already present.
    expect(result).toEqual([compactionSummary(), m1, m2, user("later"), assistant("response")]);
  });

  it("preserves markers with body content", () => {
    const m = marker("git-log", "HEAD ref: abc1234");
    const before = [sys("prompt"), m, user("what branch?"), assistant("main")];
    const after = [compactionSummary(), user("what branch?"), assistant("main")];

    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual([compactionSummary(), m, user("what branch?"), assistant("main")]);
  });

  it("does not mutate the input arrays", () => {
    const m = marker("task-start");
    const before = [m, user("hello")];
    const after = [compactionSummary(), user("hello")];

    const beforeCopy = [...before];
    const afterCopy = [...after];

    preserveChannelMarkers(before, after);

    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });

  it("returns identity-like pass-through when before has no markers", () => {
    const before: ChatTurnMessage[] = [];
    const after = [compactionSummary(), user("only")];
    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual(after);
    expect(result).not.toBe(after);
  });

  it("handles an empty after transcript", () => {
    const m = marker("task-start");
    const before = [m, user("hello")];
    const after: ChatTurnMessage[] = [];

    const result = preserveChannelMarkers(before, after);
    expect(result).toEqual([m]);
  });
});
