import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validateTypedSubagentYield } from '../../src/swarm/typedSubagentYield.js';

describe("validateTypedSubagentYield", () => {
  const resultSchema = z.object({ summary: z.string(), confidence: z.number() }).strict();

  it("accepts a result that satisfies the requested shape", () => {
    const result = { summary: "Repository scan complete", confidence: 0.9 };

    expect(validateTypedSubagentYield(result, resultSchema)).toEqual({
      ok: true,
      value: result
    });
  });

  it("fails closed when the result is missing a required field", () => {
    expect(validateTypedSubagentYield({ summary: "Repository scan complete" }, resultSchema)).toEqual({
      ok: false,
      error: "Subagent yield does not match the requested schema."
    });
  });

  it("fails closed when schema processing throws", () => {
    const throwingSchema = z.string().transform(() => {
      throw new Error("schema processing failed");
    });

    expect(validateTypedSubagentYield("result", throwingSchema)).toEqual({
      ok: false,
      error: "Subagent yield does not match the requested schema."
    });
  });
});
