import { describe, it, expect } from "vitest";
import {
  applyStrategy,
  listStrategies,
  registerStrategy,
  type CondenserStrategy,
} from "../../src/memory/condenserStrategyRegistry.js";
import type { Message } from "../../src/memory/types.js";

const makeMsg = (role: Message["role"], content: string): Message => ({
  role,
  content,
});

describe("condenserStrategyRegistry", () => {
  it("registers and lists built-in strategies", () => {
    const ids = listStrategies();
    expect(ids).toContain("drop-oldest");
    expect(ids).toContain("summarize-tail");
    expect(ids).toContain("keep-system");
  });

  it("drop-oldest shortens a long non-system tail under tight budget", () => {
    const messages: Message[] = [
      makeMsg("system", "sys"),
      makeMsg("user", "u1"),
      makeMsg("assistant", "a1"),
      makeMsg("user", "u2"),
      makeMsg("assistant", "a2"),
    ];

    // With maxTokens=0 the stub drops to minimal (system + last non-system)
    const result = applyStrategy("drop-oldest", messages, 0);
    expect(result.length).toBeLessThan(messages.length);
    expect(result[0].role).toBe("system");
    expect(result[result.length - 1].content).toBe("a2");
  });

  it("keep-system returns only system messages", () => {
    const messages: Message[] = [
      makeMsg("system", "sys1"),
      makeMsg("user", "u1"),
      makeMsg("system", "sys2"),
      makeMsg("assistant", "a1"),
    ];

    const result = applyStrategy("keep-system", messages, 1000);
    expect(result.every((m) => m.role === "system")).toBe(true);
    expect(result.length).toBe(2);
  });

  it("throws on unknown strategy id", () => {
    const messages: Message[] = [makeMsg("user", "hi")];
    expect(() => applyStrategy("nonexistent-strategy", messages, 100)).toThrow(
      /Unknown condenser strategy/
    );
  });

  it("allows registering a custom strategy at runtime", () => {
    const custom: CondenserStrategy = (msgs) => msgs.slice(0, 1);
    registerStrategy("custom-test", custom);

    const messages: Message[] = [
      makeMsg("user", "first"),
      makeMsg("user", "second"),
    ];
    const result = applyStrategy("custom-test", messages, 1000);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("first");
  });
});
