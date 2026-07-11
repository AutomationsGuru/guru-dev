import { describe, expect, it } from "vitest";

import {
  formatContextReport,
  formatConversationExport,
  pickAssistantReply
} from "../../src/guru.js";
import type { ChatTurnMessage } from "../../src/model/directChat.js";

const history: ChatTurnMessage[] = [
  { role: "system", content: "you are guru" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "first reply" },
  { role: "user", content: "again" },
  { role: "assistant", content: "second reply with details" }
];

describe("formatConversationExport — /export", () => {
  it("writes markdown with user/assistant sections and skips system", () => {
    const md = formatConversationExport(history, {
      title: "Test chat",
      routeId: "sakana/fugu-ultra",
      exportedAt: "2026-07-10T00:00:00.000Z"
    });
    expect(md).toContain("# Test chat");
    expect(md).toContain("route: sakana/fugu-ultra");
    expect(md).toContain("## User");
    expect(md).toContain("hello");
    expect(md).toContain("## Assistant");
    expect(md).toContain("second reply with details");
    expect(md).not.toContain("you are guru");
  });
});

describe("pickAssistantReply — /copy", () => {
  it("returns the latest assistant reply by default", () => {
    expect(pickAssistantReply(history)).toBe("second reply with details");
  });

  it("returns the Nth-latest reply", () => {
    expect(pickAssistantReply(history, 2)).toBe("first reply");
  });

  it("returns null when there is no such reply", () => {
    expect(pickAssistantReply(history, 9)).toBeNull();
    expect(pickAssistantReply([{ role: "user", content: "only me" }])).toBeNull();
  });
});

describe("formatContextReport — /context", () => {
  it("reports window percentage when footprint + window are known", () => {
    const lines = formatContextReport({
      inputTokens: 1000,
      outputTokens: 200,
      lastInputTokens: 50_000,
      turns: 3,
      contextWindowTokens: 100_000,
      routeId: "zai/glm-5-turbo"
    });
    expect(lines.some((line) => line.includes("route: zai/glm-5-turbo"))).toBe(true);
    expect(lines.some((line) => /context: 50000\/100000 \(~50%\)/.test(line))).toBe(true);
  });

  it("honest empty state before any turn", () => {
    const lines = formatContextReport({
      inputTokens: 0,
      outputTokens: 0,
      lastInputTokens: 0,
      turns: 0,
      routeId: null
    });
    expect(lines.some((line) => /no footprint yet/i.test(line))).toBe(true);
  });
});
