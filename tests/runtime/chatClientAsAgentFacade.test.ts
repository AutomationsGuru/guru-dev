import { describe, expect, it } from "vitest";

import {
  ChatClientAgentOptionsSchema,
  GuruAgentConfigSchema,
  mapChatClientToGuruAgentConfig
} from '../../src/runtime/chatClientAsAgentFacade.js';

describe("mapChatClientToGuruAgentConfig", () => {
  it("maps name, instructions, and tools to a Guru agent config", () => {
    const config = mapChatClientToGuruAgentConfig({
      name: "repo-assistant",
      instructions: "You answer questions about this repository.",
      tools: [
        { id: "repo-context" },
        { id: "shell-exec", description: "Run shell commands" }
      ]
    });

    expect(config.name).toBe("repo-assistant");
    expect(config.systemPrompt).toBe("You answer questions about this repository.");
    expect(config.toolIds).toEqual(["repo-context", "shell-exec"]);
    expect(config.source).toBe("chat-client-agent-facade");
  });

  it("defaults tools to an empty list when omitted", () => {
    const config = mapChatClientToGuruAgentConfig({
      name: "plain-chat",
      instructions: "Be helpful."
    });

    expect(config.toolIds).toEqual([]);
  });

  it("passes an optional model through to the config", () => {
    const config = mapChatClientToGuruAgentConfig({
      name: "modeled",
      instructions: "Be helpful.",
      model: "gpt-5.6-luna"
    });

    expect(config.model).toBe("gpt-5.6-luna");
  });

  it("omits model from the config when not provided", () => {
    const config = mapChatClientToGuruAgentConfig({
      name: "unmodeled",
      instructions: "Be helpful."
    });

    expect("model" in config).toBe(false);
  });

  it("rejects options with an empty name", () => {
    expect(() =>
      mapChatClientToGuruAgentConfig({
        name: "   ",
        instructions: "Be helpful."
      })
    ).toThrow();
  });

  it("rejects options with empty instructions", () => {
    expect(() =>
      mapChatClientToGuruAgentConfig({
        name: "no-instructions",
        instructions: ""
      })
    ).toThrow();
  });

  it("rejects unknown top-level fields (strict options)", () => {
    expect(() =>
      mapChatClientToGuruAgentConfig({
        name: "strict",
        instructions: "Be helpful.",
        temperature: 0.2
      } as never)
    ).toThrow();
  });

  it("rejects tools with an empty id", () => {
    expect(() =>
      mapChatClientToGuruAgentConfig({
        name: "bad-tool",
        instructions: "Be helpful.",
        tools: [{ id: "" }]
      })
    ).toThrow();
  });

  it("produces a config that satisfies GuruAgentConfigSchema", () => {
    const config = mapChatClientToGuruAgentConfig({
      name: "schema-check",
      instructions: "Be helpful.",
      tools: [{ id: "file-edit" }]
    });

    expect(() => GuruAgentConfigSchema.parse(config)).not.toThrow();
  });

  it("exposes ChatClientAgentOptionsSchema for caller-side validation", () => {
    const parsed = ChatClientAgentOptionsSchema.parse({
      name: "direct",
      instructions: "Be helpful."
    });

    expect(parsed.tools).toEqual([]);
  });
});
