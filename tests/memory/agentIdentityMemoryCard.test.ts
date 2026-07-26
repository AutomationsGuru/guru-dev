import { describe, expect, it } from "vitest";

import {
  AgentIdentityCardSchema,
  isIdentityCard,
  parseIdentityCard,
  serializeIdentityCard
} from "../../src/memory/agentIdentityMemoryCard.js";

describe("agent identity memory card", () => {
  const card = {
    name: "Guru: memory steward",
    principles: ["Preserve operator intent", "Cite durable learning"],
    taboos: ["Never claim authority"],
    body: "A descriptive memory artifact."
  };

  it("round-trips a structured card through Markdown", () => {
    const parsed = parseIdentityCard(serializeIdentityCard(card));

    expect(parsed).toEqual(card);
  });

  it("normalizes CRLF input and produces stable serialization", () => {
    const source = serializeIdentityCard(card).replace(/\n/gu, "\r\n");
    const parsed = parseIdentityCard(source);

    expect(parsed).toEqual(card);
    expect(serializeIdentityCard(parsed ?? card)).toBe(serializeIdentityCard(card));
  });

  it("supports a minimal descriptive card", () => {
    const parsed = parseIdentityCard("---\ntype: identity\nname: Guru\n---\n\n");

    expect(parsed).toEqual({ name: "Guru", principles: [], taboos: [], body: "" });
  });

  it("reads quoted and unquoted list entries", () => {
    const parsed = parseIdentityCard(
      "---\nname: Guru\nprinciples:\n  - \"Keep: context\"\n  - Preserve intent\ntaboos:\n  - \"Claim authority\"\n---\n\nBody\n"
    );

    expect(parsed).toEqual({
      name: "Guru",
      principles: ["Keep: context", "Preserve intent"],
      taboos: ["Claim authority"],
      body: "Body"
    });
  });

  it("does not treat identity metadata as authority", () => {
    const text = serializeIdentityCard(card);

    expect(isIdentityCard(text)).toBe(true);
    expect(parseIdentityCard(text)).toMatchObject({ name: card.name });
  });

  it("quotes special names and preserves multiline bodies", () => {
    const source = { ...card, name: "Guru: steward", body: "First line\nSecond line" };

    expect(parseIdentityCard(serializeIdentityCard(source))).toEqual(source);
  });

  it("rejects malformed and explicitly non-identity cards", () => {
    expect(parseIdentityCard("name: Guru")).toBeUndefined();
    expect(parseIdentityCard("---\ntype: profile\nname: Guru\n---\n")).toBeUndefined();
    expect(parseIdentityCard("---\ntype: identity\nname:\n---\n")).toBeUndefined();
  });

  it("rejects empty identity list entries through the schema", () => {
    expect(() => AgentIdentityCardSchema.parse({ name: "Guru", principles: [""], taboos: [] })).toThrow();
  });

  it("identifies only frontmatter marked as an identity card", () => {
    expect(isIdentityCard("---\ntype: identity\nname: Guru\n---\n")).toBe(true);
    expect(isIdentityCard("---\ntype: profile\nname: Guru\n---\n")).toBe(false);
    expect(isIdentityCard("identity")).toBe(false);
  });
});
