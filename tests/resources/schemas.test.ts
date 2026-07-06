/**
 * Parse-verification for the frozen resource schemas (Dev 4 skeletons).
 * Proves prompts/packages/themes compile and parse under strict Zod + repo TS config.
 */

import { describe, expect, it } from "vitest";

import { PromptSnippetSchema, PromptTemplateSchema } from "../../src/resources/prompts.js";
import { ResourcePackageSchema } from "../../src/resources/packages.js";
import { ThemeSchema } from "../../src/resources/themes.js";

describe("prompt template schema", () => {
  it("parses with variables and applies trust/scope defaults", () => {
    const parsed = PromptTemplateSchema.parse({
      id: "code-review",
      name: "Code review",
      body: "Review {{target}} carefully.",
      variables: [{ name: "target", required: true }]
    });
    expect(parsed.trust).toBe("untrusted");
    expect(parsed.scope).toBe("project");
    expect(parsed.variables[0]?.required).toBe(true);
    expect(parsed.tags).toEqual([]);
  });
});

describe("resource package schema", () => {
  it("parses entries and defaults kind/trust", () => {
    const parsed = ResourcePackageSchema.parse({
      id: "pk1",
      name: "Base pack",
      entries: [{ kind: "skill", ref: "D:/skills/x" }]
    });
    expect(parsed.kind).toBe("mixed");
    expect(parsed.trust).toBe("untrusted");
    expect(parsed.entries).toHaveLength(1);
  });
});

describe("theme schema", () => {
  it("parses tokens and inheritance", () => {
    const parsed = ThemeSchema.parse({
      id: "dark-1",
      name: "Dark",
      tokens: [{ name: "bg", value: "#1f1f28" }],
      inherits: "base"
    });
    expect(parsed.isDark).toBe(true);
    expect(parsed.tokens[0]?.value).toBe("#1f1f28");
    expect(parsed.inherits).toBe("base");
  });
});

describe("resource scope + snippets", () => {
  it("prompt template scope defaults to project and accepts shared/configured", () => {
    expect(PromptTemplateSchema.parse({ id: "t", name: "T", body: "x" }).scope).toBe("project");
    expect(PromptTemplateSchema.parse({ id: "t", name: "T", body: "x", scope: "shared" }).scope).toBe("shared");
  });

  it("prompt snippet parses with toolId", () => {
    const parsed = PromptSnippetSchema.parse({ id: "s", toolId: "mcp_call_tool", body: "Be precise." });
    expect(parsed.scope).toBe("project");
    expect(parsed.toolId).toBe("mcp_call_tool");
  });

  it("package and theme carry scope", () => {
    expect(ResourcePackageSchema.parse({ id: "p", name: "P", entries: [] }).scope).toBe("project");
    expect(ThemeSchema.parse({ id: "t", name: "T", tokens: [] }).scope).toBe("project");
  });
});
