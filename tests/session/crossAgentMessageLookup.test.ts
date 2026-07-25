import { describe, expect, it } from "vitest";

import {
  CrossAgentLookupPolicySchema,
  canLookup,
  lookup,
  type IndexedMessage
} from '../../src/session/crossAgentMessageLookup.js';

const INDEX: readonly IndexedMessage[] = [
  { role: "system", content: "You are a builder agent." },
  { role: "user", content: "Find the worktree for the compaction task." },
  { role: "assistant", content: "The worktree lives under /home/codex/worktrees." },
  { role: "user", content: "Also check the compaction token budget." }
];

describe("canLookup", () => {
  it("allows when the target's allowlist names the requesting agent", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["agent-a"] } });
    expect(canLookup("agent-a", "agent-b", policy)).toBe(true);
  });

  it("allows any requesting agent under the wildcard grant", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["*"] } });
    expect(canLookup("agent-c", "agent-b", policy)).toBe(true);
  });

  it("denies when the requesting agent is not in the target's allowlist", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["agent-c"] } });
    expect(canLookup("agent-a", "agent-b", policy)).toBe(false);
  });

  it("denies when the target has no allowlist entry at all", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-c": ["agent-a"] } });
    expect(canLookup("agent-a", "agent-b", policy)).toBe(false);
  });

  it("always allows an agent to look up its own index", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: {} });
    expect(canLookup("agent-a", "agent-a", policy)).toBe(true);
  });
});

describe("lookup", () => {
  it("returns scrubbed hits when the policy allows", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["agent-a"] } });
    const hits = lookup("agent-a", "agent-b", INDEX, { query: "compaction" }, policy);
    expect(hits).not.toBeNull();
    expect(hits).toEqual([
      {
        agentId: "agent-b",
        index: 1,
        role: "user",
        content: "Find the worktree for the compaction task."
      },
      {
        agentId: "agent-b",
        index: 3,
        role: "user",
        content: "Also check the compaction token budget."
      }
    ]);
  });

  it("matches case-insensitively", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["agent-a"] } });
    const hits = lookup("agent-a", "agent-b", INDEX, { query: "WORKTREE" }, policy);
    expect(hits?.map((hit) => hit.index)).toEqual([1, 2]);
  });

  it("returns null when the policy denies — no contents leak", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["agent-c"] } });
    expect(lookup("agent-a", "agent-b", INDEX, { query: "compaction" }, policy)).toBeNull();
  });

  it("honours the result limit", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["*"] } });
    const hits = lookup("agent-a", "agent-b", INDEX, { query: "the", limit: 2 }, policy);
    expect(hits).toHaveLength(2);
  });

  it("rejects a limit above the hard cap", () => {
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["*"] } });
    expect(() => lookup("agent-a", "agent-b", INDEX, { query: "the", limit: 51 }, policy)).toThrow();
  });

  it("scrubs secret-shaped content before it crosses the agent boundary", () => {
    const secretIndex: readonly IndexedMessage[] = [
      { role: "user", content: "Use key sk-abcdefghijklmnopqrstuvwxyz123456 for the call." }
    ];
    const policy = CrossAgentLookupPolicySchema.parse({ allow: { "agent-b": ["agent-a"] } });
    const hits = lookup("agent-a", "agent-b", secretIndex, { query: "key" }, policy);
    expect(hits).toHaveLength(1);
    expect(hits?.[0]?.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});
