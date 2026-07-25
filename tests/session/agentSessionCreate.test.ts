import { describe, expect, it } from "vitest";

import { agentSessionCreate, AGENT_SESSION_SHELL_LOCAL } from '../../src/session/agentSessionCreate.js';

describe("agentSessionCreate (IDEA-F259-AGENT-SESSION-01)", () => {
  it("returns a session with an id, empty history, and the default local shell backend", () => {
    const session = agentSessionCreate();
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.history).toEqual([]);
    expect(session.shellBackend).toBe(AGENT_SESSION_SHELL_LOCAL);
    expect(session.shellBackend).toBe("local");
  });

  it("generates a unique id on every call (no id reuse across sessions)", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      const id = agentSessionCreate().id;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("gives every session an independent empty history (no shared array)", () => {
    const a = agentSessionCreate();
    const b = agentSessionCreate();
    expect(a.history).not.toBe(b.history);
    (a.history as unknown[]).push({ role: "user", content: "mutated" });
    expect(b.history).toEqual([]);
  });

  it("honors an explicit id override", () => {
    const session = agentSessionCreate({ id: "session-fixed-1" });
    expect(session.id).toBe("session-fixed-1");
    expect(session.history).toEqual([]);
    expect(session.shellBackend).toBe("local");
  });

  it("honors an explicit shellBackend override (e.g. hosted from F243/F252)", () => {
    const session = agentSessionCreate({ shellBackend: "hosted" });
    expect(session.shellBackend).toBe("hosted");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.history).toEqual([]);
  });

  it("honors both overrides together", () => {
    const session = agentSessionCreate({ id: "session-fixed-2", shellBackend: "hosted" });
    expect(session).toEqual({ id: "session-fixed-2", history: [], shellBackend: "hosted" });
  });
});
