import { describe, expect, it } from "vitest";

import {
  AgentsMdSubagentParseError,
  formatAgentsMdSubagentFrontmatter,
  parseAgentsMdSubagent
} from "../../src/agents/agentsMdSubagentFrontmatter.js";

describe("parseAgentsMdSubagent", () => {
  it("parses a valid frontmatter block with name only", () => {
    const markdown = "---\nname: code-reviewer\n---\n# Code reviewer\nBody.";

    const parsed = parseAgentsMdSubagent({ markdown });

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.body).toBe("# Code reviewer\nBody.");
    expect(parsed.frontmatter).toEqual({ name: "code-reviewer" });
  });

  it("parses name with model and tools array", () => {
    const markdown = [
      "---",
      "name: research",
      "model: gpt-5.6-luna",
      "tools: [WebSearch, WebFetch]",
      "---",
      "Body."
    ].join("\n");

    const parsed = parseAgentsMdSubagent({ markdown });

    expect(parsed.frontmatter).toEqual({
      name: "research",
      model: "gpt-5.6-luna",
      tools: ["WebSearch", "WebFetch"]
    });
  });

  it("treats a blank/empty markdown as no frontmatter", () => {
    const parsed = parseAgentsMdSubagent({ markdown: "" });

    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe("");
  });

  it("treats a markdown without a leading fence as no frontmatter", () => {
    const markdown = "# Heading\nNo frontmatter here.";

    const parsed = parseAgentsMdSubagent({ markdown });

    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toBeNull();
    expect(parsed.body).toBe(markdown);
  });

  it("rejects when the frontmatter block is missing the name field", () => {
    const markdown = "---\nmodel: gpt-5.6-luna\n---\nBody.";

    expect(() => parseAgentsMdSubagent({ markdown })).toThrowError(AgentsMdSubagentParseError);
  });

  it("rejects when the frontmatter name is empty after trimming", () => {
    const markdown = "---\nname:    \n---\nBody.";

    expect(() => parseAgentsMdSubagent({ markdown })).toThrowError(AgentsMdSubagentParseError);
  });

  it("rejects an unknown key in strict mode", () => {
    const markdown = "---\nname: agent\ndescription: not allowed\n---\nBody.";

    expect(() => parseAgentsMdSubagent({ markdown })).toThrowError(AgentsMdSubagentParseError);
  });

  it("rejects when the closing fence is missing", () => {
    const markdown = "---\nname: agent\nNo closer.";

    try {
      parseAgentsMdSubagent({ markdown });
      throw new Error("expected AgentsMdSubagentParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentsMdSubagentParseError);
      expect((error as AgentsMdSubagentParseError).issues[0]?.message).toContain("unterminated");
    }
  });

  it("rejects when the tools entry is not a list", () => {
    const markdown = "---\nname: agent\ntools: oops-this-should-be-a-list\n---\nBody.";

    expect(() => parseAgentsMdSubagent({ markdown })).toThrowError(AgentsMdSubagentParseError);
  });

  it("rejects when the tools array contains an empty entry", () => {
    const markdown = "---\nname: agent\ntools: [Read, , Edit]\n---\nBody.";

    expect(() => parseAgentsMdSubagent({ markdown })).toThrowError(AgentsMdSubagentParseError);
  });

  it("strips a leading UTF-8 BOM before detecting the opener fence", () => {
    const bom = "﻿";
    const markdown = `${bom}---\nname: agent\n---\nBody.`;

    const parsed = parseAgentsMdSubagent({ markdown });

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter).toEqual({ name: "agent" });
  });
});

describe("formatAgentsMdSubagentFrontmatter", () => {
  it("round-trips through parseAgentsMdSubagent", () => {
    const original = {
      name: "reviewer",
      model: "gpt-5.6-luna",
      tools: ["Read", "Edit"]
    };

    const formatted = formatAgentsMdSubagentFrontmatter(original);
    const parsed = parseAgentsMdSubagent({ markdown: `${formatted}\nBody.` });

    expect(parsed.frontmatter).toEqual(original);
  });

  it("formats a name-only block without model or tools", () => {
    const formatted = formatAgentsMdSubagentFrontmatter({ name: "solo" });
    expect(formatted).toBe("---\nname: solo\n---");
  });

  it("formats an empty tools array as `[]`", () => {
    const formatted = formatAgentsMdSubagentFrontmatter({ name: "scoped", tools: [] });
    expect(formatted).toBe("---\nname: scoped\ntools: []\n---");
  });
});
