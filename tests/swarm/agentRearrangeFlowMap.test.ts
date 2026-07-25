import { describe, expect, it } from "vitest";

import {
  parseFlowMap,
  RearrangeParseError,
  RearrangeValidationError
} from '../../src/swarm/agentRearrangeFlowMap.js';

const AGENTS = new Set(["a", "b", "c", "d", "e"]);

// ---------------------------------------------------------------------------
// Happy-path parsing
// ---------------------------------------------------------------------------

describe("agentRearrangeFlowMap — parsing", () => {
  it("parses a single rule with one target: a -> b", () => {
    const edges = parseFlowMap("a -> b", AGENTS);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toEqual(["b"]);
  });

  it("parses a single rule with multiple targets: a -> b, c", () => {
    const edges = parseFlowMap("a -> b, c", AGENTS);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toEqual(["b", "c"]);
  });

  it("parses multiple rules separated by newlines", () => {
    const edges = parseFlowMap("a -> b, c\nd -> e", AGENTS);
    expect(edges).toHaveLength(2);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toEqual(["b", "c"]);
    expect(edges[1]!.from).toBe("d");
    expect(edges[1]!.to).toEqual(["e"]);
  });

  it("parses multiple rules separated by semicolons", () => {
    const edges = parseFlowMap("a -> b; c -> d, e", AGENTS);
    expect(edges).toHaveLength(2);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toEqual(["b"]);
    expect(edges[1]!.from).toBe("c");
    expect(edges[1]!.to).toEqual(["d", "e"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseFlowMap("", AGENTS)).toEqual([]);
    expect(parseFlowMap("   ", AGENTS)).toEqual([]);
    expect(parseFlowMap("\n\n", AGENTS)).toEqual([]);
  });

  it("strips whitespace around agent names and separators", () => {
    const edges = parseFlowMap("  a  ->   b  ,  c  ", AGENTS);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Validation: unknown agents
// ---------------------------------------------------------------------------

describe("agentRearrangeFlowMap — validation", () => {
  it("fails when source agent is unknown", () => {
    expect(() => parseFlowMap("z -> b", AGENTS)).toThrow(RearrangeValidationError);
    try {
      parseFlowMap("z -> b", AGENTS);
    } catch (err) {
      expect(err).toBeInstanceOf(RearrangeValidationError);
      expect((err as RearrangeValidationError).code).toBe("rearrange_validation_error");
      expect((err as RearrangeValidationError).agent).toBe("z");
      expect((err as RearrangeValidationError).message).toContain("z");
    }
  });

  it("fails when any target agent is unknown", () => {
    expect(() => parseFlowMap("a -> z", AGENTS)).toThrow(RearrangeValidationError);
    try {
      parseFlowMap("a -> b, z, c", AGENTS);
    } catch (err) {
      expect(err).toBeInstanceOf(RearrangeValidationError);
      expect((err as RearrangeValidationError).agent).toBe("z");
    }
  });

  it("fails on first unknown agent (fail-fast)", () => {
    // Both x and z are unknown; the parser should fail on the first one (x).
    try {
      parseFlowMap("x -> z", new Set(["a"]));
    } catch (err) {
      expect(err).toBeInstanceOf(RearrangeValidationError);
      expect((err as RearrangeValidationError).agent).toBe("x");
    }
  });
});

// ---------------------------------------------------------------------------
// Parse errors
// ---------------------------------------------------------------------------

describe("agentRearrangeFlowMap — parse errors", () => {
  it("fails when -> is missing", () => {
    expect(() => parseFlowMap("a b c", AGENTS)).toThrow(RearrangeParseError);
    try {
      parseFlowMap("no arrow here", AGENTS);
    } catch (err) {
      expect(err).toBeInstanceOf(RearrangeParseError);
      expect((err as RearrangeParseError).code).toBe("rearrange_parse_error");
      expect((err as RearrangeParseError).message).toContain("->");
    }
  });

  it("fails when source agent is empty", () => {
    expect(() => parseFlowMap(" -> b", AGENTS)).toThrow(RearrangeParseError);
    try {
      parseFlowMap(" -> b", AGENTS);
    } catch (err) {
      expect(err).toBeInstanceOf(RearrangeParseError);
      expect((err as RearrangeParseError).message).toContain("Empty source");
    }
  });

  it("fails when there are no targets after ->", () => {
    expect(() => parseFlowMap("a -> ", AGENTS)).toThrow(RearrangeParseError);
    try {
      parseFlowMap("a -> ,  ,  ", AGENTS);
    } catch (err) {
      expect(err).toBeInstanceOf(RearrangeParseError);
      expect((err as RearrangeParseError).message).toContain("No target");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("agentRearrangeFlowMap — edge cases", () => {
  it("allows self-loops (validation is name-existence, not graph-correctness)", () => {
    const edges = parseFlowMap("a -> a", AGENTS);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe("a");
    expect(edges[0]!.to).toEqual(["a"]);
  });

  it("allows duplicate rules (caller owns dedup)", () => {
    const edges = parseFlowMap("a -> b\na -> b", AGENTS);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual(edges[1]);
  });

  it("allows overlapping targets across rules", () => {
    const edges = parseFlowMap("a -> b, c\nb -> c, d", AGENTS);
    expect(edges).toHaveLength(2);
    expect(edges[0]!.to).toEqual(["b", "c"]);
    expect(edges[1]!.to).toEqual(["c", "d"]);
  });

  it("returns readonly arrays (structural guarantee)", () => {
    const edges = parseFlowMap("a -> b, c", AGENTS);
    expect(edges[0]!.to).toBeDefined();
    // The return type is readonly — verified at compile time by TS strict mode.
    // Runtime check: the array itself is a frozen-like contract; we just verify
    // the values are correct.
    expect(edges[0]!.to.length).toBe(2);
  });

  it("handles a single rule with many targets", () => {
    const ids = new Set(["x", "t1", "t2", "t3", "t4", "t5"]);
    const edges = parseFlowMap("x -> t1, t2, t3, t4, t5", ids);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to).toHaveLength(5);
  });

  it("handles mixed newline and semicolon separators", () => {
    const edges = parseFlowMap("a -> b\nc -> d; e -> a", AGENTS);
    expect(edges).toHaveLength(3);
    expect(edges[0]!.from).toBe("a");
    expect(edges[1]!.from).toBe("c");
    expect(edges[2]!.from).toBe("e");
  });
});
