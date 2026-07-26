import { describe, expect, it } from "vitest";

import {
  AgentCardSchema,
  canonicalizeAgentCard,
  parseAgentCard,
  serializeAgentCard,
} from "../../src/agents/a2aAgentCard.js";

describe("a2aAgentCard", () => {
  describe("AgentCardSchema", () => {
    it("accepts a minimal card with id and name", () => {
      const card = AgentCardSchema.parse({ id: "guru-1", name: "Guru" });
      expect(card).toEqual({ id: "guru-1", name: "Guru", capabilities: [] });
    });

    it("accepts a full card with a capabilities array", () => {
      const card = AgentCardSchema.parse({
        id: "guru-1",
        name: "Guru",
        capabilities: ["read", "write", "execute"],
      });
      expect(card.capabilities).toEqual(["read", "write", "execute"]);
    });

    it("defaults capabilities to an empty array when absent", () => {
      const card = AgentCardSchema.parse({ id: "guru-1", name: "Guru" });
      expect(card.capabilities).toEqual([]);
    });

    it("rejects an empty id", () => {
      expect(() => AgentCardSchema.parse({ id: "", name: "Guru" })).toThrow();
    });

    it("rejects an empty name", () => {
      expect(() => AgentCardSchema.parse({ id: "guru-1", name: "" })).toThrow();
    });

    it("rejects an empty capability entry", () => {
      expect(() =>
        AgentCardSchema.parse({ id: "guru-1", name: "Guru", capabilities: ["ok", ""] })
      ).toThrow();
    });

    it("trims whitespace on id, name, and capability entries", () => {
      const card = AgentCardSchema.parse({
        id: "  guru-1  ",
        name: "  Guru  ",
        capabilities: ["  read  "],
      });
      expect(card).toEqual({ id: "guru-1", name: "Guru", capabilities: ["read"] });
    });

    it("rejects unknown top-level keys (strict object)", () => {
      expect(() =>
        AgentCardSchema.parse({ id: "guru-1", name: "Guru", extra: true })
      ).toThrow();
    });
  });

  describe("parseAgentCard", () => {
    it("parses a valid raw card", () => {
      const parsed = parseAgentCard({
        id: "agent-x",
        name: "Agent X",
        capabilities: ["chat"],
      });
      expect(parsed).toEqual({
        id: "agent-x",
        name: "Agent X",
        capabilities: ["chat"],
      });
    });

    it("throws on non-object input", () => {
      expect(() => parseAgentCard("not-a-card")).toThrow();
      expect(() => parseAgentCard(null)).toThrow();
      expect(() => parseAgentCard(42)).toThrow();
    });

    it("preserves duplicate capabilities as-authored", () => {
      const parsed = parseAgentCard({
        id: "agent-x",
        name: "Agent X",
        capabilities: ["read", "read"],
      });
      expect(parsed.capabilities).toEqual(["read", "read"]);
    });
  });

  describe("serializeAgentCard", () => {
    it("emits canonical JSON with keys in id, name, capabilities order", () => {
      const json = serializeAgentCard({
        id: "guru-1",
        name: "Guru",
        capabilities: ["read", "write"],
      });
      // Stable key order: id, name, capabilities.
      expect(json).toBe(
        JSON.stringify({ id: "guru-1", name: "Guru", capabilities: ["read", "write"] })
      );
    });

    it("always includes capabilities, even when empty", () => {
      const json = serializeAgentCard({ id: "guru-1", name: "Guru" });
      expect(JSON.parse(json)).toEqual({ id: "guru-1", name: "Guru", capabilities: [] });
    });

    it("normalizes raw input through validation before emitting", () => {
      const json = serializeAgentCard({
        id: "  guru-1  ",
        name: "  Guru  ",
        capabilities: ["  read  "],
      });
      expect(JSON.parse(json)).toEqual({
        id: "guru-1",
        name: "Guru",
        capabilities: ["read"],
      });
    });

    it("rejects invalid input rather than emitting malformed JSON", () => {
      expect(() => serializeAgentCard({ id: "", name: "Guru" })).toThrow();
    });
  });

  describe("roundtrip", () => {
    it("serialize → parse is lossless for a populated card", () => {
      const original = {
        id: "guru-1",
        name: "Guru",
        capabilities: ["read", "write", "execute"],
      };
      const roundTripped = parseAgentCard(serializeAgentCard(original));
      expect(roundTripped).toEqual(original);
    });

    it("serialize → parse is lossless for a minimal card", () => {
      const original = { id: "guru-1", name: "Guru" };
      const roundTripped = parseAgentCard(serializeAgentCard(original));
      expect(roundTripped).toEqual({ id: "guru-1", name: "Guru", capabilities: [] });
    });

    it("canonicalize equals parse for the same normalized input", () => {
      const raw = { id: "  guru-1 ", name: "Guru ", capabilities: [" read"] };
      expect(canonicalizeAgentCard(raw)).toEqual(parseAgentCard(raw));
    });
  });
});
