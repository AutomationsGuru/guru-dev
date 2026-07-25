import { describe, expect, it } from "vitest";

import { ConversationSwitchStack } from '../../src/session/conversationSwitchStack.js';

describe("ConversationSwitchStack — push / pop / peek", () => {
  it("starts empty with depth 0", () => {
    const stack = new ConversationSwitchStack();
    expect(stack.depth).toBe(0);
    expect(stack.maxDepth).toBe(20);
    expect(stack.peek()).toBeUndefined();
  });

  it("push adds an id and peek returns it without removing", () => {
    const stack = new ConversationSwitchStack();
    stack.push("conv-aaa");
    expect(stack.depth).toBe(1);
    expect(stack.peek()).toBe("conv-aaa");
    expect(stack.depth).toBe(1); // peek is non-destructive
  });

  it("pop removes and returns the top id", () => {
    const stack = new ConversationSwitchStack();
    stack.push("conv-aaa");
    const popped = stack.pop();
    expect(popped).toBe("conv-aaa");
    expect(stack.depth).toBe(0);
    expect(stack.peek()).toBeUndefined();
  });

  it("maintains LIFO order across multiple pushes", () => {
    const stack = new ConversationSwitchStack();
    stack.push("first");
    stack.push("second");
    stack.push("third");
    expect(stack.depth).toBe(3);
    expect(stack.pop()).toBe("third");
    expect(stack.pop()).toBe("second");
    expect(stack.pop()).toBe("first");
    expect(stack.depth).toBe(0);
  });

  it("pop on empty stack returns undefined", () => {
    const stack = new ConversationSwitchStack();
    expect(stack.pop()).toBeUndefined();
    expect(stack.depth).toBe(0);
  });

  it("peek on empty stack returns undefined", () => {
    const stack = new ConversationSwitchStack();
    expect(stack.peek()).toBeUndefined();
  });

  it("push / pop / peek round-trip after draining", () => {
    const stack = new ConversationSwitchStack();
    stack.push("a"); stack.push("b");
    expect(stack.pop()).toBe("b");
    expect(stack.pop()).toBe("a");
    // drained
    expect(stack.pop()).toBeUndefined();
    expect(stack.peek()).toBeUndefined();
    // re-fill
    stack.push("c");
    expect(stack.peek()).toBe("c");
    expect(stack.depth).toBe(1);
  });
});

describe("ConversationSwitchStack — max depth enforcement", () => {
  it("allows push up to the default maxDepth (20)", () => {
    const stack = new ConversationSwitchStack();
    for (let i = 0; i < 20; i++) {
      stack.push(`conv-${i}`);
    }
    expect(stack.depth).toBe(20);
    expect(stack.peek()).toBe("conv-19");
  });

  it("rejects push when depth equals maxDepth", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 3 });
    stack.push("a"); stack.push("b"); stack.push("c");
    expect(() => stack.push("d")).toThrow(/max depth/i);
    expect(stack.depth).toBe(3); // state unchanged
    expect(stack.peek()).toBe("c");
  });

  it("rejects push at depth 0 when maxDepth is 0", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 0 });
    expect(() => stack.push("a")).toThrow(/max depth/i);
    expect(stack.depth).toBe(0);
  });

  it("accepts custom maxDepth", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 5 });
    for (let i = 0; i < 5; i++) stack.push(`id-${i}`);
    expect(stack.depth).toBe(5);
    expect(() => stack.push("overflow")).toThrow();
  });

  it("maxDepth of 1 — single push succeeds, second rejects", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 1 });
    stack.push("only");
    expect(stack.depth).toBe(1);
    expect(stack.peek()).toBe("only");
    expect(() => stack.push("rejected")).toThrow(/max depth/i);
  });

  it("pop frees a slot so push succeeds again after hitting max", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 2 });
    stack.push("a"); stack.push("b");
    expect(() => stack.push("c")).toThrow();
    stack.pop(); // free one slot
    stack.push("c");
    expect(stack.depth).toBe(2);
    expect(stack.peek()).toBe("c");
    expect(stack.pop()).toBe("c");
    expect(stack.pop()).toBe("a");
  });

  it("exposes maxDepth as a readonly property", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 7 });
    expect(stack.maxDepth).toBe(7);
    // Verify it doesn't change after operations
    stack.push("x"); stack.push("y");
    expect(stack.maxDepth).toBe(7);
  });
});

describe("ConversationSwitchStack — constructor validation", () => {
  it("rejects negative maxDepth", () => {
    expect(() => new ConversationSwitchStack({ maxDepth: -1 })).toThrow(
      /non-negative integer/,
    );
  });

  it("rejects non-integer maxDepth", () => {
    expect(
      () => new ConversationSwitchStack({ maxDepth: 3.5 }),
    ).toThrow(/non-negative integer/);
  });
});

describe("ConversationSwitchStack — error message content", () => {
  it("overflow error includes the max depth value", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 4 });
    for (let i = 0; i < 4; i++) stack.push(`id-${i}`);
    expect(() => stack.push("overflow")).toThrow(/4/);
  });

  it("overflow error includes the rejected id", () => {
    const stack = new ConversationSwitchStack({ maxDepth: 1 });
    stack.push("existing");
    expect(() => stack.push("my-custom-id")).toThrow(/my-custom-id/);
  });
});
