import { describe, expect, it } from "vitest";

import {
  AgentIdentityCardSchema,
  type AgentIdentityCard,
  isIdentityCard,
  parseIdentityCard,
  serializeIdentityCard
} from "../../src/memory/agentIdentityMemoryCard.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentIdentityCard> = {}): AgentIdentityCard {
  return {
    name: "test-agent",
    principles: ["Be helpful", "Be accurate"],
    taboos: ["Never lie", "Never expose secrets"],
    body: "A test agent for unit tests.",
    ...overrides
  };
}

// ── roundtrip ───────────────────────────────────────────────────────────────

describe("agent identity memory card — roundtrip", () => {
  it("serialize → parse returns an equivalent card", () => {
    const original = makeCard();
    const text = serializeIdentityCard(original);
    const parsed = parseIdentityCard(text);
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe(original.name);
    expect(parsed!.principles).toEqual(original.principles);
    expect(parsed!.taboos).toEqual(original.taboos);
    expect(parsed!.body).toBe(original.body);
  });

  it("parse → serialize → parse is stable (idempotent)", () => {
    const original = makeCard();
    const first = serializeIdentityCard(original);
    const parsed = parseIdentityCard(first)!;
    const second = serializeIdentityCard(parsed);
    const reparse = parseIdentityCard(second);
    expect(reparse).toBeDefined();
    expect(reparse!.name).toBe(original.name);
    expect(reparse!.principles).toEqual(original.principles);
    expect(reparse!.taboos).toEqual(original.taboos);
    // Body is preserved (possibly trimmed differently, but content matches).
    expect(reparse!.body).toBe(original.body);
  });

  it("minimal card with empty lists roundtrips", () => {
    const minimal: AgentIdentityCard = { name: "min", principles: [], taboos: [], body: "" };
    const text = serializeIdentityCard(minimal);
    const parsed = parseIdentityCard(text);
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe("min");
    expect(parsed!.principles).toEqual([]);
    expect(parsed!.taboos).toEqual([]);
    expect(parsed!.body).toBe("");
  });

  it("card with many principles and taboos roundtrips", () => {
    const large = makeCard({
      name: "loaded-agent",
      principles: Array.from({ length: 20 }, (_, i) => `Principle ${i + 1}: do the right thing in scenario ${i + 1}`),
      taboos: Array.from({ length: 15 }, (_, i) => `Taboo ${i + 1}: never do wrong thing ${i + 1}`),
      body: "A heavily loaded identity card with many constraints."
    });
    const text = serializeIdentityCard(large);
    const parsed = parseIdentityCard(text);
    expect(parsed).toBeDefined();
    expect(parsed!.principles).toEqual(large.principles);
    expect(parsed!.taboos).toEqual(large.taboos);
  });
});

// ── serialize ───────────────────────────────────────────────────────────────

describe("serializeIdentityCard", () => {
  it("emits type: identity in frontmatter", () => {
    const text = serializeIdentityCard(makeCard());
    expect(text).toContain("type: identity");
  });

  it("emits name as unquoted when safe", () => {
    const text = serializeIdentityCard(makeCard({ name: "safe-name" }));
    expect(text).toContain("name: safe-name");
  });

  it("quotes name when it contains special characters", () => {
    const text = serializeIdentityCard(makeCard({ name: "test: agent" }));
    expect(text).toContain('name: "test: agent"');
  });

  it("emits principles as an indented list", () => {
    const text = serializeIdentityCard(makeCard({ principles: ["Be honest", "Stay curious"] }));
    const lines = text.split("\n");
    expect(lines).toContain('  - "Be honest"');
    expect(lines).toContain('  - "Stay curious"');
    expect(lines).toContain("principles:");
  });

  it("emits taboos as an indented list", () => {
    const text = serializeIdentityCard(makeCard({ taboos: ["Never destroy", "Never expose"] }));
    const lines = text.split("\n");
    expect(lines).toContain('  - "Never destroy"');
    expect(lines).toContain('  - "Never expose"');
    expect(lines).toContain("taboos:");
  });

  it("omits principles section when list is empty", () => {
    const text = serializeIdentityCard(makeCard({ principles: [] }));
    expect(text).not.toContain("principles:");
  });

  it("omits taboos section when list is empty", () => {
    const text = serializeIdentityCard(makeCard({ taboos: [] }));
    expect(text).not.toContain("taboos:");
  });

  it("places body after the closing fence", () => {
    const text = serializeIdentityCard(makeCard({ body: "The narrative body." }));
    const fenceEnd = text.lastIndexOf("---\n");
    expect(fenceEnd).toBeGreaterThan(0);
    expect(text.slice(fenceEnd)).toContain("The narrative body.");
  });

  it("trailing newline after body", () => {
    const text = serializeIdentityCard(makeCard({ body: "hello" }));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("throws on invalid card (Zod validation)", () => {
    expect(() => serializeIdentityCard({ name: "", principles: [], taboos: [], body: "" } as AgentIdentityCard)).toThrow();
  });
});

// ── parse ───────────────────────────────────────────────────────────────────

describe("parseIdentityCard", () => {
  it("returns undefined for empty string", () => {
    expect(parseIdentityCard("")).toBeUndefined();
  });

  it("returns undefined for text without frontmatter fence", () => {
    expect(parseIdentityCard("just some text\nno frontmatter\n")).toBeUndefined();
  });

  it("returns undefined when closing fence is missing", () => {
    expect(parseIdentityCard("---\nname: test\n")).toBeUndefined();
  });

  it("returns undefined when name is missing", () => {
    expect(parseIdentityCard("---\ntype: identity\n---\n\nbody\n")).toBeUndefined();
  });

  it("returns undefined when type is present but not 'identity'", () => {
    expect(parseIdentityCard("---\nname: test\ntype: project\n---\n\nbody\n")).toBeUndefined();
  });

  it("parses valid card without type marker (permissive)", () => {
    const result = parseIdentityCard("---\nname: simple-agent\nprinciples:\n- \"Be good\"\n---\n\nJust a simple agent.\n");
    expect(result).toBeDefined();
    expect(result!.name).toBe("simple-agent");
    expect(result!.principles).toEqual(["Be good"]);
  });

  it("parses unquoted list items", () => {
    const text = "---\nname: test\nprinciples:\n- honesty\n- accuracy\n---\n\nbody\n";
    const result = parseIdentityCard(text);
    expect(result).toBeDefined();
    expect(result!.principles).toEqual(["honesty", "accuracy"]);
  });

  it("parses quoted list items", () => {
    const text = '---\nname: test\nprinciples:\n- "Be honest"\n- "Stay curious"\n---\n\nbody\n';
    const result = parseIdentityCard(text);
    expect(result).toBeDefined();
    expect(result!.principles).toEqual(["Be honest", "Stay curious"]);
  });

  it("handles mixed quoted and unquoted items", () => {
    const text = '---\nname: test\nprinciples:\n- "Be honest"\n- accuracy\n- "Stay: curious"\n---\n\nbody\n';
    const result = parseIdentityCard(text);
    expect(result).toBeDefined();
    expect(result!.principles).toEqual(["Be honest", "accuracy", "Stay: curious"]);
  });

  it("handles CRLF line endings", () => {
    const text = "---\r\nname: test\r\nprinciples:\r\n- \"Be honest\"\r\n---\r\n\r\nbody\r\n";
    const result = parseIdentityCard(text);
    expect(result).toBeDefined();
    expect(result!.name).toBe("test");
    expect(result!.principles).toEqual(["Be honest"]);
    expect(result!.body).toBe("body");
  });

  it("returns undefined when name is empty string", () => {
    expect(parseIdentityCard('---\nname: ""\ntype: identity\n---\n\nbody\n')).toBeUndefined();
  });
});

// ── isIdentityCard ──────────────────────────────────────────────────────────

describe("isIdentityCard", () => {
  it("returns true for a valid identity card", () => {
    const text = serializeIdentityCard(makeCard());
    expect(isIdentityCard(text)).toBe(true);
  });

  it("returns false for non-identity type", () => {
    const text = "---\nname: test\ntype: project\n---\n\nbody\n";
    expect(isIdentityCard(text)).toBe(false);
  });

  it("returns false for text without frontmatter", () => {
    expect(isIdentityCard("just text")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isIdentityCard("")).toBe(false);
  });

  it("returns false when type field is missing", () => {
    const text = "---\nname: test\n---\n\nbody\n";
    expect(isIdentityCard(text)).toBe(false);
  });
});

// ── schema ──────────────────────────────────────────────────────────────────

describe("AgentIdentityCardSchema", () => {
  it("accepts a valid card", () => {
    const result = AgentIdentityCardSchema.safeParse(makeCard());
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "", principles: [], taboos: [], body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name over 120 chars", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "a".repeat(121), principles: [], taboos: [], body: "" });
    expect(result.success).toBe(false);
  });

  it("accepts name exactly 120 chars", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "a".repeat(120), principles: [], taboos: [], body: "" });
    expect(result.success).toBe(true);
  });

  it("rejects empty principle string in array", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "test", principles: ["valid", ""], taboos: [], body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty taboo string in array", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "test", principles: [], taboos: [""], body: "" });
    expect(result.success).toBe(false);
  });

  it("defaults missing fields", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.principles).toEqual([]);
      expect(result.data.taboos).toEqual([]);
      expect(result.data.body).toBe("");
    }
  });

  it("rejects unknown extra fields", () => {
    const result = AgentIdentityCardSchema.safeParse({ name: "test", extra: "nope" });
    expect(result.success).toBe(false);
  });
});

// ── cross-platform line endings ─────────────────────────────────────────────

describe("cross-platform line endings", () => {
  it("serialize always emits LF only", () => {
    const text = serializeIdentityCard(makeCard());
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\r\n");
  });

  it("parse handles CRLF input transparently", () => {
    const text = serializeIdentityCard(makeCard());
    const crlfText = text.replace(/\n/g, "\r\n");
    const parsed = parseIdentityCard(crlfText);
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe("test-agent");
  });
});
