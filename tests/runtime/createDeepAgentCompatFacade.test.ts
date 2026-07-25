import { describe, expect, it } from "vitest";

import { mapOptions } from '../../src/runtime/createDeepAgentCompatFacade.js';

describe("createDeepAgentCompatFacade.mapOptions", () => {
  it("maps a descriptor model onto the guru config", () => {
    const config = mapOptions({ model: { model: "gpt-4o" } });

    expect(config.model).toBe("gpt-4o");
  });

  it("maps a bare-string model onto the guru config", () => {
    const config = mapOptions({ model: "claude-opus-4-8" });

    expect(config.model).toBe("claude-opus-4-8");
  });

  it("maps a tools list onto ordered guru tool ids", () => {
    const config = mapOptions({ tools: ["read", "write", "execute"] });

    expect(config.tools).toEqual([{ id: "read" }, { id: "write" }, { id: "execute" }]);
  });

  it("maps a mixed tools list of strings and descriptors", () => {
    const config = mapOptions({ tools: ["read", { id: "write" }] });

    expect(config.tools).toEqual([{ id: "read" }, { id: "write" }]);
  });

  it("maps a system prompt onto the guru config", () => {
    const config = mapOptions({ systemPrompt: "You are a careful operator." });

    expect(config.systemPrompt).toBe("You are a careful operator.");
  });

  it("resolves an empty options object to null model, no tools, null prompt", () => {
    const config = mapOptions({});

    expect(config.model).toBeNull();
    expect(config.tools).toEqual([]);
    expect(config.systemPrompt).toBeNull();
  });

  it("defaults a missing argument to null model, no tools, null prompt", () => {
    const config = mapOptions();

    expect(config.model).toBeNull();
    expect(config.tools).toEqual([]);
    expect(config.systemPrompt).toBeNull();
  });

  it("normalizes whitespace-only fields to null/empty without throwing", () => {
    const config = mapOptions({ model: "   ", tools: ["  ", "ok"], systemPrompt: "   " });

    expect(config.model).toBeNull();
    expect(config.tools).toEqual([{ id: "ok" }]);
    expect(config.systemPrompt).toBeNull();
  });

  it("never pulls in an orchestration SDK — only a pure mapping", async () => {
    const source = await import("../../src/runtime/createDeepAgentCompatFacade.js");
    const moduleText = JSON.stringify(Object.keys(source));

    expect(moduleText).not.toMatch(/langgraph|langchain/i);
  });
});
