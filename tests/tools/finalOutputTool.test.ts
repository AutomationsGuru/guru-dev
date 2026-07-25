import { z } from "zod";

import { createFinalOutputTool, FINAL_OUTPUT_MAX_REPAIR_ATTEMPTS } from '../../src/tools/builtins/finalOutputTool.js';
import {
  compileFinalJsonSchema,
  validateFinalJson
} from '../../src/tools/finalOutput/validateFinalJson.js';
import { createToolRegistry, executeRegisteredTool } from '../../src/tools/registry.js';

describe("final_output tool", () => {
  const tool = createFinalOutputTool();

  describe("createFinalOutputTool definition", () => {
    it("declares a stable id, read-only effect, and typed schemas", () => {
      expect(tool.id).toBe("final_output");
      expect(tool.effect).toBe("read-only");
      expect(tool.title).toMatch(/final/i);
      expect(tool.inputSchema).toBeInstanceOf(z.ZodType);
      expect(tool.outputSchema).toBeInstanceOf(z.ZodType);
    });

    it("registers cleanly into a tool registry", () => {
      const registry = createToolRegistry([tool]);
      expect(registry.get("final_output")?.id).toBe("final_output");
    });
  });

  describe("no schema — any JSON value is accepted", () => {
    it("accepts a plain object on attempt 1", async () => {
      const observation = await run(tool, { value: { hello: "world" } });
      expect(observation.status).toBe("succeeded");
      expect(outcome(observation)).toEqual({
        outcome: "accepted",
        ok: true,
        repairBudgetExhausted: false,
        errors: []
      });
    });

    it("accepts primitives and arrays", async () => {
      for (const value of [42, "answer", true, null, [1, 2, 3]]) {
        const observation = await run(tool, { value });
        expect(observation.status).toBe("succeeded");
        expect((observation.output as { ok: boolean }).ok).toBe(true);
      }
    });

    it("rejects non-JSON values (undefined, function, bigint) with a root error", async () => {
      const observation = await run(tool, { value: () => 0, attempt: 1 });
      expect(observation.status).toBe("succeeded");
      const output = observation.output as { ok: boolean; errors: { path: string }[] };
      expect(output.ok).toBe(false);
      expect(output.errors[0]?.path).toBe("root");
    });
  });

  describe("with schema — shape is enforced", () => {
    const schema = {
      type: "object",
      required: ["name", "count"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0 }
      }
    } as const;

    it("accepts a conforming value", async () => {
      const observation = await run(tool, {
        value: { name: "widget", count: 3 },
        schema
      });
      expect(outcome(observation).ok).toBe(true);
      expect((observation.output as { outcome: string }).outcome).toBe("accepted");
    });

    it("reports structured field errors on a mismatched value (one repair turn)", async () => {
      const observation = await run(tool, {
        value: { name: 7, count: -1 },
        schema
      });
      expect(observation.status).toBe("succeeded");
      const output = observation.output as {
        outcome: string;
        ok: boolean;
        errors: { path: string; message: string }[];
      };
      expect(output.ok).toBe(false);
      expect(output.outcome).toBe("needs_repair");
      const paths = output.errors.map((error) => error.path).sort();
      expect(paths).toEqual(expect.arrayContaining(["count", "name"]));
      expect(output.errors.every((error) => error.message.length > 0)).toBe(true);
    });

    it("enforces additionalProperties:false (extra keys are errors)", async () => {
      const observation = await run(tool, {
        value: { name: "widget", count: 1, extra: true },
        schema
      });
      const output = observation.output as { ok: boolean; outcome: string };
      expect(output.ok).toBe(false);
      expect(output.outcome).toBe("needs_repair");
    });
  });

  describe("repair simulation", () => {
    const schema = {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } }
    } as const;

    it("simulates a successful repair: attempt 1 invalid -> attempt 2 valid", async () => {
      const first = await run(tool, { value: { answer: 42 }, schema, attempt: 1 });
      expect((first.output as { outcome: string }).outcome).toBe("needs_repair");

      // Model corrected `answer` to a string after seeing the first error set.
      const repaired = await run(tool, { value: { answer: "forty-two" }, schema, attempt: 2 });
      expect(outcome(repaired)).toEqual({
        outcome: "accepted",
        ok: true,
        repairBudgetExhausted: false,
        errors: []
      });
    });

    it("fail-closes when the repair also fails (attempt 2 still invalid)", async () => {
      const failedRepair = await run(tool, { value: { answer: 99 }, schema, attempt: 2 });
      const output = failedRepair.output as {
        outcome: string;
        ok: boolean;
        repairBudgetExhausted: boolean;
      };
      expect(output.outcome).toBe("closed");
      expect(output.ok).toBe(false);
      expect(output.repairBudgetExhausted).toBe(true);
    });
  });

  describe("fail-closed hard edge", () => {
    const schema = { type: "string" } as const;

    it("closes immediately when attempt exceeds the repair budget, even on a valid value", async () => {
      const observation = await run(tool, { value: "perfectly-valid", schema, attempt: 3 });
      const output = observation.output as {
        outcome: string;
        ok: boolean;
        repairBudgetExhausted: boolean;
      };
      expect(output.outcome).toBe("closed");
      expect(output.ok).toBe(false);
      expect(output.repairBudgetExhausted).toBe(true);
    });

    it("exposes the repair budget constant as 2 (one repair turn past the first answer)", () => {
      expect(FINAL_OUTPUT_MAX_REPAIR_ATTEMPTS).toBe(2);
    });
  });

  describe("invalid schema is closed, not repaired", () => {
    it("closes when the schema itself is malformed (missing type)", async () => {
      const observation = await run(tool, { value: { x: 1 }, schema: { required: ["x"] } });
      const output = observation.output as { outcome: string; ok: boolean; errors: { path: string }[] };
      expect(output.outcome).toBe("closed");
      expect(output.ok).toBe(false);
      expect(output.errors[0]?.path).toBe("schema");
    });
  });

  describe("registry integration", () => {
    it("runs end-to-end through executeRegisteredTool with input/output validation", async () => {
      const registry = createToolRegistry([tool]);
      const observation = await executeRegisteredTool(registry, "final_output", {
        value: { ok: true },
        attempt: 1
      });
      expect(observation.status).toBe("succeeded");
      expect((observation.output as { outcome: string }).outcome).toBe("accepted");
    });

    it("fails registered execution for bad input (strict schema strips unknown keys)", async () => {
      const registry = createToolRegistry([tool]);
      const observation = await executeRegisteredTool(registry, "final_output", {
        value: {},
        attempt: 0
      });
      expect(observation.status).toBe("failed");
      expect(observation.error).toMatch(/attempt/i);
    });
  });
});

describe("validateFinalJson (unit)", () => {
  it("passes any JSON value when no schema is given", () => {
    expect(validateFinalJson({ a: 1 }).ok).toBe(true);
    expect(validateFinalJson("x").ok).toBe(true);
    expect(validateFinalJson(null).ok).toBe(true);
  });

  it("returns dot-pathed errors for nested mismatches", () => {
    const schema = {
      type: "object",
      required: ["list"],
      properties: { list: { type: "array", items: { type: "string" } } }
    } as const;
    const result = validateFinalJson({ list: ["ok", 5, "fine"] }, schema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.startsWith("list"))).toBe(true);
  });

  it("compiles a schema into a working zod validator", () => {
    const validator = compileFinalJsonSchema({ type: "integer", minimum: 10 });
    expect(validator.safeParse(15).success).toBe(true);
    expect(validator.safeParse(3).success).toBe(false);
  });

  it("throws on a schema missing type/const/enum", () => {
    expect(() => compileFinalJsonSchema({ minimum: 1 } as never)).toThrow(/type, const, or enum/);
  });
});

async function run(
  tool: ReturnType<typeof createFinalOutputTool>,
  input: Record<string, unknown>
) {
  // Route through the registry so the strict input schema and output sanitizer
  // are exercised the same way the real harness would call the tool.
  const registry = createToolRegistry([tool]);
  return executeRegisteredTool(registry, "final_output", input);
}

function outcome(observation: { output?: unknown }) {
  const output = observation.output as
    | { outcome: string; ok: boolean; repairBudgetExhausted: boolean; errors: unknown[] }
    | undefined;
  if (!output) {
    throw new Error("tool produced no output");
  }
  return {
    outcome: output.outcome,
    ok: output.ok,
    repairBudgetExhausted: output.repairBudgetExhausted,
    errors: output.errors
  };
}
