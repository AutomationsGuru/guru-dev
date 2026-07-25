import { describe, expect, it } from "vitest";

import {
  compactToolResults,
  DEFAULT_MAX_TOOL_CHARS,
  type CompactionMessage
} from '../../src/memory/toolResultCompactionStrategy.js';

function toolMsg(content: string): CompactionMessage {
  return { role: "tool", content };
}

function userMsg(content: string): CompactionMessage {
  return { role: "user", content };
}

describe("toolResultCompactionStrategy", () => {
  it("returns messages unchanged when every tool result is under the threshold", () => {
    const messages: CompactionMessage[] = [
      userMsg("read the config"),
      toolMsg("{ ok: true }"),
      { role: "assistant", content: "done" }
    ];
    const out = compactToolResults(messages, 1000);
    expect(out).toEqual(messages);
    // identity preserved for the small tool result
    expect(out[1]).toBe(messages[1]);
  });

  it("shrinks an oversized tool result to a short summary stub", () => {
    const big = "x".repeat(5000);
    const messages: CompactionMessage[] = [userMsg("go"), toolMsg(big)];
    // keepRecentCount: 0 — the single result is also the newest, which default
    // keep-recent=1 would otherwise protect.
    const out = compactToolResults(messages, 1000, { keepRecentCount: 0 });
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe("tool");
    expect(out[1]!.content.length).toBeLessThan(big.length);
    expect(out[1]!.content).toContain("compacted");
    // head preserved so the model keeps context
    expect(out[1]!.content).toContain("x".repeat(40));
  });

  it("compacts only tool-role messages, leaving large user/assistant text intact", () => {
    const bigUser = "u".repeat(5000);
    const messages: CompactionMessage[] = [userMsg(bigUser)];
    const out = compactToolResults(messages, 100);
    expect(out[0]!.content).toBe(bigUser);
  });

  it("keeps the newest tool results verbatim while compacting older ones (keep-recent)", () => {
    const big = "y".repeat(4000);
    const messages: CompactionMessage[] = [
      toolMsg(big),       // oldest → compacted
      toolMsg(big),       // newest → kept (keepRecentCount default 1)
      userMsg("next")
    ];
    const out = compactToolResults(messages, 100);
    expect(out[0]!.content).toContain("compacted");
    expect(out[1]!.content).toBe(big); // newest verbatim
  });

  it("respects keepRecentCount=0 to compact every oversized tool result", () => {
    const big = "z".repeat(4000);
    const messages: CompactionMessage[] = [toolMsg(big), toolMsg(big)];
    const out = compactToolResults(messages, 100, { keepRecentCount: 0 });
    expect(out[0]!.content).toContain("compacted");
    expect(out[1]!.content).toContain("compacted");
  });

  it("does not mutate the input array or messages", () => {
    const big = "w".repeat(4000);
    const original = toolMsg(big);
    const messages: CompactionMessage[] = [original];
    compactToolResults(messages, 100);
    expect(original.content).toBe(big);
    expect(messages[0]).toBe(original);
  });

  it("treats content at exactly the threshold as unchanged (strictly-greater rule)", () => {
    const exact = "e".repeat(1000);
    const messages: CompactionMessage[] = [toolMsg(exact)];
    const out = compactToolResults(messages, 1000, { keepRecentCount: 0 });
    expect(out[0]!.content).toBe(exact);
  });

  it("uses DEFAULT_MAX_TOOL_CHARS when maxToolChars is omitted", () => {
    const over = "d".repeat(DEFAULT_MAX_TOOL_CHARS + 50);
    const messages: CompactionMessage[] = [toolMsg(over)];
    const out = compactToolResults(messages, undefined, { keepRecentCount: 0 });
    expect(out[0]!.content).toContain("compacted");
  });

  it("handles an empty message list", () => {
    expect(compactToolResults([], 100)).toEqual([]);
  });

  it("records original length in the stub for auditability", () => {
    const big = "q".repeat(4321);
    const out = compactToolResults([toolMsg(big)], 100, { keepRecentCount: 0 });
    expect(out[0]!.content).toContain("4321");
  });
});
