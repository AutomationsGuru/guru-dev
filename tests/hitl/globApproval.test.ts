import { describe, expect, it } from "vitest";

import { matchGlob, requestWebhookApproval } from '../../src/hitl/globApproval.js';

describe("matchGlob", () => {
  it("matches exact tool names and '*' wildcard segments", () => {
    expect(matchGlob("bash", ["bash"])).toBe(true);
    expect(matchGlob("git.pr.run", ["git.*"])).toBe(true);
    expect(matchGlob("fs.edit.apply", ["git.*"])).toBe(false);
  });

  it("treats a matching glob as a forced approval trigger", () => {
    expect(matchGlob("git.pr.run", ["git.pr.*", "bash"])).toBe(true);
    expect(matchGlob("read", ["git.pr.*", "bash"])).toBe(false);
  });

  it("supports '?' single-character matching and ignores blank patterns", () => {
    expect(matchGlob("web_fetch", ["web?fetch"])).toBe(true);
    expect(matchGlob("web_fetch", ["", "web??fetch"])).toBe(false);
  });
});

describe("requestWebhookApproval", () => {
  it("approves a non-hard-edge decision only when the callback matches the request binding", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const decision = await requestWebhookApproval({
      url: "https://example.test/hitl",
      toolName: "git.pr.run",
      hardEdge: false,
      requestId: "req-123",
      callbackToken: "tok-123",
      summary: "Need approval for git.pr.run.",
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ url: String(url), body });
        return new Response(
          JSON.stringify({
            decision: "approve",
            requestId: "req-123",
            callbackToken: "tok-123"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: "https://example.test/hitl",
      body: {
        toolName: "git.pr.run",
        hardEdge: false,
        requestId: "req-123",
        callbackToken: "tok-123",
        summary: "Need approval for git.pr.run."
      }
    });
    expect(decision).toEqual({ outcome: "approve", callbackAccepted: true, advisoryOutcome: "approve" });
  });

  it("fails closed to ask when the callback binding does not match the request", async () => {
    const decision = await requestWebhookApproval({
      url: "https://example.test/hitl",
      toolName: "git.pr.run",
      hardEdge: false,
      requestId: "req-123",
      callbackToken: "tok-123",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            decision: "approve",
            requestId: "req-123",
            callbackToken: "wrong-token"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    });

    expect(decision).toEqual({ outcome: "ask", callbackAccepted: false, advisoryOutcome: null });
  });

  it("never auto-approves a hard edge even when the webhook votes approve", async () => {
    const decision = await requestWebhookApproval({
      url: "https://example.test/hitl",
      toolName: "bash",
      hardEdge: true,
      requestId: "req-123",
      callbackToken: "tok-123",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            decision: "approve",
            requestId: "req-123",
            callbackToken: "tok-123"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    });

    expect(decision).toEqual({ outcome: "ask", callbackAccepted: true, advisoryOutcome: "approve" });
  });

  it("passes through an explicit webhook deny", async () => {
    const decision = await requestWebhookApproval({
      url: "https://example.test/hitl",
      toolName: "git.pr.run",
      hardEdge: false,
      requestId: "req-123",
      callbackToken: "tok-123",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            decision: "deny",
            requestId: "req-123",
            callbackToken: "tok-123"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    });

    expect(decision).toEqual({ outcome: "deny", callbackAccepted: true, advisoryOutcome: "deny" });
  });

  it("fails closed to ask when the webhook request errors", async () => {
    const decision = await requestWebhookApproval({
      url: "https://example.test/hitl",
      toolName: "git.pr.run",
      hardEdge: false,
      requestId: "req-123",
      callbackToken: "tok-123",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as typeof fetch
    });

    expect(decision).toEqual({ outcome: "ask", callbackAccepted: false, advisoryOutcome: null });
  });
});
