import { describe, expect, it } from "vitest";

import {
  SpecPacketSchema,
  validateSpec
} from '../../src/planning/specPacketSchema.js';

/**
 * Spec packet schema (IDEA-F371-SPEC-01, R-KIRO-SPEC) — focused tests for the
 * pure `{ goals, constraints, acceptance[] }` shape validator.
 *
 * The RED→GREEN contract this packet is built against:
 *   - missing `acceptance` (or an empty array) FAILS the validator; and
 *   - a well-formed packet PASSES.
 */

const VALID_PACKET = {
  goals: ["Ship the spec packet schema"],
  constraints: ["No third-party schema library beyond zod"],
  acceptance: [{ statement: "validateSpec accepts a well-formed packet" }]
} as const;

describe("validateSpec — missing acceptance fails (the RED→GREEN contract)", () => {
  it("fails when acceptance is missing entirely", () => {
    const result = validateSpec({ goals: ["ship X"], constraints: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/acceptance/u);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("fails when acceptance is an empty array", () => {
    const result = validateSpec({ goals: ["ship X"], constraints: [], acceptance: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/acceptance/u);
    }
  });
});

describe("validateSpec — well-formed packet passes", () => {
  it("accepts a packet with goals, constraints, and a non-empty acceptance", () => {
    const result = validateSpec(VALID_PACKET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packet.goals).toEqual(["Ship the spec packet schema"]);
      expect(result.packet.acceptance).toHaveLength(1);
      expect(result.packet.acceptance[0]?.statement).toBe(
        "validateSpec accepts a well-formed packet"
      );
    }
  });

  it("applies the default empty constraints array when omitted", () => {
    const result = validateSpec({
      goals: ["ship X"],
      acceptance: [{ statement: "X runs" }]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packet.constraints).toEqual([]);
    }
  });

  it("accepts an optional check reference on an acceptance item", () => {
    const result = validateSpec({
      goals: ["ship X"],
      acceptance: [{ statement: "X runs", check: "npm run test" }]
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateSpec — structural edge cases", () => {
  it("fails when goals is missing", () => {
    const result = validateSpec({ constraints: [], acceptance: [{ statement: "x" }] });
    expect(result.ok).toBe(false);
  });

  it("fails when goals is an empty array", () => {
    const result = validateSpec({ goals: [], acceptance: [{ statement: "x" }] });
    expect(result.ok).toBe(false);
  });

  it("fails when an acceptance item is missing its statement", () => {
    const result = validateSpec({ goals: ["ship X"], acceptance: [{ check: "x" }] });
    expect(result.ok).toBe(false);
  });

  it("fails on unknown top-level keys (strict)", () => {
    const result = validateSpec({ ...VALID_PACKET, extra: "nope" });
    expect(result.ok).toBe(false);
  });

  it("fails for non-object input", () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec("not a packet").ok).toBe(false);
    expect(validateSpec(undefined).ok).toBe(false);
  });
});

describe("SpecPacketSchema — direct zod access", () => {
  it("exposes the schema for callers that prefer safeParse", () => {
    const parsed = SpecPacketSchema.safeParse(VALID_PACKET);
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty acceptance at the schema level", () => {
    const parsed = SpecPacketSchema.safeParse({ goals: ["ship X"], acceptance: [] });
    expect(parsed.success).toBe(false);
  });
});
