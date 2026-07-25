import {
  StructuredTaskOutputSchemaDefSchema,
  TaskOutputFieldDeclSchema,
  TaskOutputValidationResultSchema,
  validate,
} from '../../src/planning/structuredTaskOutputSchema.js';
import type {
  StructuredTaskOutputSchemaDef,
  TaskOutputFieldDecl,
} from '../../src/planning/structuredTaskOutputSchema.js';

// ── helpers ──────────────────────────────────────────────────

const stringReq: TaskOutputFieldDecl = {
  name: "title",
  type: "string",
  required: true,
};
const numberOpt: TaskOutputFieldDecl = {
  name: "count",
  type: "number",
  required: false,
};
const boolReq: TaskOutputFieldDecl = {
  name: "ok",
  type: "boolean",
  required: true,
};
const arrayReq: TaskOutputFieldDecl = {
  name: "items",
  type: "array",
  required: true,
};
const objectReq: TaskOutputFieldDecl = {
  name: "meta",
  type: "object",
  required: true,
};

function schema(fields: TaskOutputFieldDecl[]): StructuredTaskOutputSchemaDef {
  return StructuredTaskOutputSchemaDefSchema.parse({ fields });
}

// ── FieldDecl schema ─────────────────────────────────────────

describe("TaskOutputFieldDeclSchema", () => {
  it("accepts a required string field", () => {
    expect(TaskOutputFieldDeclSchema.parse(stringReq)).toEqual(stringReq);
  });

  it("defaults required to true when omitted", () => {
    const parsed = TaskOutputFieldDeclSchema.parse({
      name: "x",
      type: "string",
    });
    expect(parsed.required).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(
      TaskOutputFieldDeclSchema.safeParse({
        name: "",
        type: "string",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown field type", () => {
    expect(
      TaskOutputFieldDeclSchema.safeParse({
        name: "x",
        type: "date",
      }).success,
    ).toBe(false);
  });
});

// ── OutputSchemaDef schema ───────────────────────────────────

describe("StructuredTaskOutputSchemaDefSchema", () => {
  it("accepts a single-field schema", () => {
    expect(
      StructuredTaskOutputSchemaDefSchema.parse({ fields: [stringReq] })
        .fields,
    ).toHaveLength(1);
  });

  it("rejects an empty fields array", () => {
    expect(
      StructuredTaskOutputSchemaDefSchema.safeParse({ fields: [] }).success,
    ).toBe(false);
  });

  it("rejects missing fields key", () => {
    expect(
      StructuredTaskOutputSchemaDefSchema.safeParse({}).success,
    ).toBe(false);
  });

  it("rejects extra unknown keys", () => {
    expect(
      StructuredTaskOutputSchemaDefSchema.safeParse({
        fields: [stringReq],
        extra: true,
      }).success,
    ).toBe(false);
  });
});

// ── validate ─────────────────────────────────────────────────

describe("validate", () => {
  // ── happy path ──────────────────────────────────────────

  it("passes when all required fields are present with correct types", () => {
    const result = validate(
      { title: "hello", ok: true },
      schema([stringReq, boolReq]),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("passes when optional fields are missing", () => {
    const result = validate(
      { title: "hello" },
      schema([stringReq, numberOpt]),
    );
    expect(result.valid).toBe(true);
  });

  it("passes when optional fields are present with correct types", () => {
    const result = validate(
      { title: "hello", count: 42 },
      schema([stringReq, numberOpt]),
    );
    expect(result.valid).toBe(true);
  });

  it("passes when output has extra undeclared fields", () => {
    const result = validate(
      { title: "hello", extra: "bonus", ok: true },
      schema([stringReq, boolReq]),
    );
    expect(result.valid).toBe(true);
  });

  it("validates all primitive types correctly", () => {
    const result = validate(
      { title: "hello", count: 1, ok: false, items: [1, 2], meta: { a: 1 } },
      schema([stringReq, numberOpt, boolReq, arrayReq, objectReq]),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // ── missing required fields ─────────────────────────────

  it("fails when a required field is missing", () => {
    const result = validate({ title: "hello" }, schema([stringReq, boolReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("ok");
    expect(result.errors[0]!.message).toContain("Missing required field");
  });

  it("fails when multiple required fields are missing", () => {
    const result = validate({}, schema([stringReq, boolReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it("fails when the only required field is missing", () => {
    const result = validate({}, schema([stringReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("title");
  });

  // ── type mismatches ─────────────────────────────────────

  it("fails when a string field has a number value", () => {
    const result = validate({ title: 42, ok: true }, schema([stringReq, boolReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("title");
    expect(result.errors[0]!.message).toContain("Type mismatch");
    expect(result.errors[0]!.message).toContain("expected string, got number");
  });

  it("fails when a boolean field has a string value", () => {
    const result = validate({ title: "hello", ok: "yes" }, schema([stringReq, boolReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("ok");
    expect(result.errors[0]!.message).toContain("expected boolean, got string");
  });

  it("fails when a number field has a string value", () => {
    const result = validate(
      { title: "hello", count: "many" },
      schema([stringReq, numberOpt]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("count");
  });

  it("fails when an array field has a plain object", () => {
    const result = validate(
      { title: "hello", ok: true, items: { not: "array" } },
      schema([stringReq, boolReq, arrayReq]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("items");
    expect(result.errors[0]!.message).toContain("expected array, got object");
  });

  it("fails when an object field has an array value", () => {
    const result = validate(
      { title: "hello", ok: true, meta: [1, 2, 3] },
      schema([stringReq, boolReq, objectReq]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("meta");
    expect(result.errors[0]!.message).toContain("expected object, got array");
  });

  it("collects both missing-field and type-mismatch errors", () => {
    const result = validate(
      { title: 99 }, // title type mismatch + ok missing
      schema([stringReq, boolReq]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  // ── non-object / null output ────────────────────────────

  it("fails when output is a string", () => {
    const result = validate("not an object", schema([stringReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("(root)");
  });

  it("fails when output is null", () => {
    const result = validate(null, schema([stringReq]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe("(root)");
  });

  it("fails when output is undefined", () => {
    const result = validate(undefined, schema([stringReq]));
    expect(result.valid).toBe(false);
  });

  it("fails when output is a number", () => {
    const result = validate(42, schema([stringReq]));
    expect(result.valid).toBe(false);
  });

  it("fails when output is an array", () => {
    const result = validate([1, 2, 3], schema([stringReq]));
    expect(result.valid).toBe(false);
  });

  // ── validation result schema ────────────────────────────

  it("returns a result that conforms to TaskOutputValidationResultSchema", () => {
    const result = validate({ title: "ok" }, schema([stringReq]));
    expect(() =>
      TaskOutputValidationResultSchema.parse(result),
    ).not.toThrow();
  });

  it("returns a conformant result on failure too", () => {
    const result = validate({}, schema([stringReq]));
    expect(() =>
      TaskOutputValidationResultSchema.parse(result),
    ).not.toThrow();
  });
});
