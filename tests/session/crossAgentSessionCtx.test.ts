import { describe, expect, it } from "vitest";

import {
  createCrossAgentSessionContext,
  type CrossAgentContextPolicy
} from '../../src/session/crossAgentSessionCtx.js';
import type { SummarizeRequest, Summarizer } from '../../src/compaction/engine.js';
import type { ChatTurnMessage } from '../../src/model/directChat.js';

const user = (content: string): ChatTurnMessage => ({ role: "user", content });
const assistant = (content: string): ChatTurnMessage => ({ role: "assistant", content });

const FULL: CrossAgentContextPolicy = { mode: "full" };
const NONE: CrossAgentContextPolicy = { mode: "none" };

/** Fake summarizer seam: records requests, returns a deterministic canned summary. */
function fakeSummarizer(summary = "SUMMARY"): { summarize: Summarizer; calls: SummarizeRequest[] } {
  const calls: SummarizeRequest[] = [];
  const summarize: Summarizer = async (request) => {
    calls.push(request);
    return summary;
  };
  return { summarize, calls };
}

describe("CrossAgentSessionContext — append", () => {
  it("accumulates turns per agent in order", () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL });
    ctx.append("a", user("u1"));
    ctx.append("a", assistant("r1"));
    ctx.append("a", user("u2"));
    expect(ctx.turns("a")).toEqual([user("u1"), assistant("r1"), user("u2")]);
  });

  it("keeps each agent's history independent", () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL });
    ctx.append("a", user("for-a"));
    ctx.append("b", user("for-b"));
    expect(ctx.turns("a")).toEqual([user("for-a")]);
    expect(ctx.turns("b")).toEqual([user("for-b")]);
  });

  it("append without an agentId targets the active agent", () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL, initialAgentId: "a" });
    ctx.append(user("hello"));
    ctx.switchAgent("b");
    ctx.append(user("world"));
    expect(ctx.turns("a")).toEqual([user("hello")]);
    expect(ctx.turns("b")).toEqual([user("world")]);
  });

  it("returns immutable snapshots (mutating the result cannot corrupt the store)", () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL });
    ctx.append("a", user("u1"));
    const snapshot = ctx.turns("a") as ChatTurnMessage[];
    snapshot.push(user("evil"));
    expect(ctx.turns("a")).toEqual([user("u1")]);
  });
});

describe("CrossAgentSessionContext — switch keeps history (R-XCTX-01)", () => {
  it("switching the active agent retains every prior agent's turns", () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL, initialAgentId: "a" });
    ctx.append(user("a-u1"));
    ctx.append(assistant("a-r1"));

    ctx.switchAgent("b");
    expect(ctx.turns("b")).toEqual([]);
    ctx.append(user("b-u1"));

    ctx.switchAgent("a");
    // A's earlier turns survived the round-trip through B.
    expect(ctx.turns("a")).toEqual([user("a-u1"), assistant("a-r1")]);
    expect(ctx.turns("b")).toEqual([user("b-u1")]);
    expect(ctx.activeAgentId()).toBe("a");
  });

  it("switchAgent to a new agent starts an empty history; agents() lists all known agents", () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL, initialAgentId: "a" });
    ctx.switchAgent("b");
    ctx.switchAgent("c");
    expect(ctx.agents()).toEqual(["a", "b", "c"]);
    expect(ctx.turns("c")).toEqual([]);
  });
});

describe("CrossAgentSessionContext — summarizeFor policy modes", () => {
  it("mode 'full': next agent receives other agents' turns verbatim plus its own history", async () => {
    const ctx = createCrossAgentSessionContext({ policy: FULL, initialAgentId: "a" });
    ctx.append(user("a-u1"));
    ctx.append(assistant("a-r1"));
    ctx.switchAgent("b");
    ctx.append(user("b-u1"));

    const shared = await ctx.summarizeFor("b");
    expect(shared.mode).toBe("full");
    expect(shared.ownTurns).toEqual([user("b-u1")]);
    expect(shared.sharedTurns).toEqual([
      { agentId: "a", turns: [user("a-u1"), assistant("a-r1")] }
    ]);
    expect(shared.summary).toBeUndefined();
  });

  it("mode 'none': next agent receives only its own history — nothing from other agents", async () => {
    const ctx = createCrossAgentSessionContext({ policy: NONE, initialAgentId: "a" });
    ctx.append(user("a-u1"));
    ctx.switchAgent("b");
    ctx.append(user("b-u1"));

    const shared = await ctx.summarizeFor("b");
    expect(shared.mode).toBe("none");
    expect(shared.ownTurns).toEqual([user("b-u1")]);
    expect(shared.sharedTurns).toEqual([]);
    expect(shared.summary).toBeUndefined();
  });

  it("mode 'summarized': injects a summary of OTHER agents' transcripts; own history stays verbatim", async () => {
    const { summarize, calls } = fakeSummarizer("A discussed the build plan.");
    const ctx = createCrossAgentSessionContext({
      policy: { mode: "summarized", summarize, maxSummaryTokens: 256 },
      initialAgentId: "a"
    });
    ctx.append(user("a-u1"));
    ctx.append(assistant("a-r1"));
    ctx.switchAgent("b");
    ctx.append(user("b-u1"));

    const shared = await ctx.summarizeFor("b");
    expect(shared.mode).toBe("summarized");
    expect(shared.summary).toBe("A discussed the build plan.");
    expect(shared.ownTurns).toEqual([user("b-u1")]);
    expect(shared.sharedTurns).toEqual([]);

    // The summarizer saw the OTHER agent's transcript (role-tagged), not B's own.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.transcriptBlock).toContain("user: a-u1");
    expect(calls[0]?.transcriptBlock).toContain("assistant: a-r1");
    expect(calls[0]?.transcriptBlock).not.toContain("b-u1");
    expect(calls[0]?.maxTokens).toBe(256);
    expect(calls[0]?.label).toBe("history");
  });

  it("mode 'summarized' with no prior agents: summarizer is NOT called, no summary", async () => {
    const { summarize, calls } = fakeSummarizer();
    const ctx = createCrossAgentSessionContext({
      policy: { mode: "summarized", summarize },
      initialAgentId: "a"
    });
    ctx.append(user("a-u1"));

    const shared = await ctx.summarizeFor("a");
    expect(shared.summary).toBeUndefined();
    expect(shared.ownTurns).toEqual([user("a-u1")]);
    expect(calls).toHaveLength(0);
  });

  it("mode 'summarized' requires a summarize hook (misconfiguration fails fast)", async () => {
    const ctx = createCrossAgentSessionContext({
      // Deliberately missing summarize — policy misconfiguration.
      policy: { mode: "summarized" } as CrossAgentContextPolicy,
      initialAgentId: "a"
    });
    ctx.append(user("a-u1"));
    ctx.switchAgent("b");
    await expect(ctx.summarizeFor("b")).rejects.toThrow(/summarize/iu);
  });

  it("summarized context covers multiple prior agents in join order", async () => {
    const { summarize, calls } = fakeSummarizer("multi-agent summary");
    const ctx = createCrossAgentSessionContext({
      policy: { mode: "summarized", summarize },
      initialAgentId: "a"
    });
    ctx.append(user("a-u1"));
    ctx.switchAgent("b");
    ctx.append(user("b-u1"));
    ctx.switchAgent("c");

    const shared = await ctx.summarizeFor("c");
    expect(shared.summary).toBe("multi-agent summary");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.transcriptBlock).toContain("a-u1");
    expect(calls[0]?.transcriptBlock).toContain("b-u1");
    // The target agent is identified for the summarizer's context.
    expect(calls[0]?.customInstructions).toContain("c");
  });
});

describe("CrossAgentSessionContext — determinism", () => {
  it("same inputs produce the same shared context (no wall clock, no randomness)", async () => {
    const build = async (): Promise<unknown> => {
      const { summarize } = fakeSummarizer("S");
      const ctx = createCrossAgentSessionContext({
        policy: { mode: "summarized", summarize },
        initialAgentId: "a"
      });
      ctx.append(user("a-u1"));
      ctx.switchAgent("b");
      ctx.append(user("b-u1"));
      return ctx.summarizeFor("b");
    };
    const first = await build();
    const second = await build();
    expect(first).toEqual(second);
  });

  it("mode 'full' summarization is deterministic too", async () => {
    const build = async (): Promise<unknown> => {
      const ctx = createCrossAgentSessionContext({ policy: FULL, initialAgentId: "a" });
      ctx.append(user("x"));
      ctx.switchAgent("b");
      return ctx.summarizeFor("b");
    };
    expect(await build()).toEqual(await build());
  });
});
