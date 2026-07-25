import { describe, it, expect } from "vitest";

import { createAgentMemoryScopeBound } from '../../src/memory/agentMemoryScopeBound.js';

/**
 * Agent memory scope bound — TDD coverage (RED→GREEN).
 *
 * Own agent scope: get/set succeed.
 * Cross-agent access (read or write, direct or via explicit other-agent prefix)
 * is denied by default — enforced in get/set, not in prose.
 */

describe("agentMemoryScopeBound", () => {
  it("own-scope: agent can set and get its own key", () => {
    const mem = createAgentMemoryScopeBound("agent-alpha");
    mem.set("fact1", { title: "Alpha Fact", body: "value for alpha" });
    const got = mem.get("fact1");
    expect(got).toEqual({ title: "Alpha Fact", body: "value for alpha" });
  });

  it("own-scope: an unset own key returns undefined (not another agent's value)", () => {
    const alpha = createAgentMemoryScopeBound("agent-alpha", {
      store: { getRaw: () => undefined, setRaw: () => {} }
    });
    expect(alpha.get("never-set")).toBeUndefined();
  });

  it("two agents on a shared store do not collide on the same key name", () => {
    const backing = new Map<string, unknown>();
    const store = {
      getRaw: (k: string) => backing.get(k),
      setRaw: (k: string, v: unknown) => {
        backing.set(k, v);
      }
    };
    const alpha = createAgentMemoryScopeBound("agent-alpha", { store });
    const beta = createAgentMemoryScopeBound("agent-beta", { store });

    alpha.set("sharedName", "alpha-value");
    beta.set("sharedName", "beta-value");

    expect(alpha.get("sharedName")).toBe("alpha-value");
    expect(beta.get("sharedName")).toBe("beta-value");
    // Underlying namespaced keys are distinct.
    expect(backing.get("agent-alpha::sharedName")).toBe("alpha-value");
    expect(backing.get("agent-beta::sharedName")).toBe("beta-value");
  });

  it("cross-agent read is denied: beta cannot read alpha's namespaced key directly", () => {
    const alpha = createAgentMemoryScopeBound("agent-alpha");
    alpha.set("secret", "alpha-only");
    const beta = createAgentMemoryScopeBound("agent-beta");
    expect(() => beta.get("agent-alpha::secret")).toThrow(/cross-agent|scope denied|access denied/i);
  });

  it("cross-agent write is denied: beta cannot write into alpha's namespace", () => {
    const alpha = createAgentMemoryScopeBound("agent-alpha");
    const beta = createAgentMemoryScopeBound("agent-beta");
    expect(() => beta.set("agent-alpha::poison", "attack")).toThrow(
      /cross-agent|scope denied|access denied/i
    );
    // alpha's own getter for that key still sees nothing.
    expect(alpha.get("poison")).toBeUndefined();
  });

  it("agentId containing the namespace separator is rejected at construction", () => {
    expect(() => createAgentMemoryScopeBound("agent-alpha::evil")).toThrow(/namespace separator/i);
  });

  it("empty agentId is rejected at construction", () => {
    expect(() => createAgentMemoryScopeBound("")).toThrow(/non-empty/i);
  });
});
