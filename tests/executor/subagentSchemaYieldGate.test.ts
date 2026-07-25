import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  assertYieldValid,
  validateYield,
  type YieldValidationResult
} from '../../src/executor/subagentSchemaYieldGate.js';

describe("validateYield", () => {
  it("accepts a valid result and returns the parsed value", () => {
    const schema = z.object({ summary: z.string(), ok: z.boolean() });
    const payload = { summary: "all tests pass", ok: true };

    const result: YieldValidationResult<{ summary: string; ok: boolean }> = validateYield(payload, schema);

    expect(result).toEqual({ ok: true, value: payload });
  });

  it("rejects a result with a missing or wrong-typed field", () => {
    const schema = z.object({ summary: z.string(), ok: z.boolean() });

    const missingField = validateYield({ ok: true }, schema);
    expect(missingField.ok).toBe(false);
    if (!missingField.ok) {
      expect(missingField.error.length).toBeGreaterThan(0);
      expect(missingField.error).toMatch(/summary|expected|required/i);
    }

    const wrongType = validateYield({ summary: 42, ok: true }, schema);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.error).toMatch(/summary|string/i);
    }
  });

  it("rejects a wrong top-level type (string where object expected)", () => {
    const schema = z.object({ summary: z.string(), ok: z.boolean() });

    const result = validateYield("not an object", schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns the parsed (transformed/defaulted) value, not the raw input", () => {
    const schema = z.object({
      summary: z.string().transform((value) => value.trim()),
      attempts: z.number().int().default(1)
    });

    const result = validateYield({ summary: "  done  " }, schema);

    expect(result).toEqual({ ok: true, value: { summary: "done", attempts: 1 } });
  });
});

describe("assertYieldValid", () => {
  it("returns the parsed value on success", () => {
    const schema = z.object({ summary: z.string(), ok: z.boolean() });
    const payload = { summary: "shipped", ok: true };

    expect(assertYieldValid(payload, schema)).toEqual(payload);
  });

  it("throws a fail-closed error prefixed with 'Invalid subagent yield:' on failure", () => {
    const schema = z.object({ summary: z.string(), ok: z.boolean() });

    expect(() => assertYieldValid({ summary: "shipped" }, schema)).toThrowError(/^Invalid subagent yield:/);
  });
});
