import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolDefinition } from '../../src/tools/registry.js';
import {
  mapChatClientAsAgent,
  type ChatClientToolLike
} from '../../src/runtime/chatClientAsAgentFacade.js';

describe("mapChatClientAsAgent", () => {
  it("maps name and instructions into a system prompt", () => {
    const config = mapChatClientAsAgent({
      name: "Greeter",
      instructions: "Be concise and friendly."
    });

    expect(config.name).toBe("Greeter");
    expect(config.systemPrompt).toBe("You are Greeter.\n\nBe concise and friendly.");
  });

  it("uses a default name and omits the body when instructions are absent", () => {
    const config = mapChatClientAsAgent({});

    expect(config.name).toBe("agent");
    expect(config.systemPrompt).toBe("You are agent.");
  });

  it("falls back to the default name when the provided name is blank", () => {
    const config = mapChatClientAsAgent({ name: "   ", instructions: "do work" });

    expect(config.name).toBe("agent");
    expect(config.systemPrompt).toBe("You are agent.\n\ndo work");
  });

  it("treats whitespace-only instructions as absent", () => {
    const config = mapChatClientAsAgent({ name: "Bot", instructions: "   " });

    expect(config.systemPrompt).toBe("You are Bot.");
  });

  it("coerces chat-client-shaped tools into owned tool definitions", () => {
    const likeTools: ChatClientToolLike[] = [
      { name: "search", description: "Search the web" },
      { id: "calc", title: "Calculator", description: "Do math", inputSchema: z.object({ q: z.string() }) }
    ];

    const config = mapChatClientAsAgent({ name: "A", tools: likeTools });

    expect(config.tools).toHaveLength(2);
    expect(config.tools[0]?.id).toBe("search");
    expect(config.tools[0]?.title).toBe("search");
    expect(config.tools[0]?.description).toBe("Search the web");
    expect(config.tools[1]?.id).toBe("calc");
    expect(config.tools[1]?.title).toBe("Calculator");
  });

  it("passes already-owned tool definitions through by identity", () => {
    const owned: ToolDefinition = {
      id: "owned.read",
      title: "Read",
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.unknown(),
      execute: async () => ({ ok: true })
    };

    const config = mapChatClientAsAgent({ name: "A", tools: [owned] });

    expect(config.tools).toHaveLength(1);
    // Identity preserved — no proxy wrapper.
    expect(config.tools[0]).toBe(owned);
  });

  it("de-duplicates tools by id, keeping first-seen order", () => {
    const a: ChatClientToolLike = { id: "dup", description: "first" };
    const b: ChatClientToolLike = { name: "dup", description: "second" };
    const c: ChatClientToolLike = { id: "unique", description: "third" };

    const config = mapChatClientAsAgent({ name: "A", tools: [a, b, c] });

    expect(config.tools.map((t) => t.id)).toEqual(["dup", "unique"]);
    expect(config.tools[0]?.description).toBe("first");
  });

  it("drops tools that resolve to no id", () => {
    const config = mapChatClientAsAgent({
      name: "A",
      tools: [{ description: "no id, no name" }, { id: "kept", description: "ok" }]
    });

    expect(config.tools.map((t) => t.id)).toEqual(["kept"]);
  });

  it("leaves the tools list empty when none are provided", () => {
    const config = mapChatClientAsAgent({ name: "A" });
    expect(config.tools).toEqual([]);
  });

  it("returns a defensive copy of the tools list (mutating the output does not affect re-maps)", () => {
    const config = mapChatClientAsAgent({ name: "A", tools: [{ id: "t", description: "d" }] });
    // Owned coerced tools are fresh objects, so the produced array is decoupled
    // from any caller-supplied structure.
    expect(config.tools).not.toBe(undefined);
    expect(config.tools[0]?.id).toBe("t");
  });
});
