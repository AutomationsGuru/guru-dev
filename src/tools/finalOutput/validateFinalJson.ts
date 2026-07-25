import { z } from "zod";

/**
 * Final-output JSON validation (Work IDEA-F36-FINAL-JSON-01).
 *
 * The final_output tool lets a workflow, pack, or ad-hoc caller require that a
 * model's terminal answer be JSON that matches an *optional* schema. The
 * validator is intentionally standalone — it depends only on `zod` (already a
 * core runtime dependency) and on no workflow/pack machinery, so the tool is
 * usable outside a full workflow pack exactly as the plan requires.
 *
 * The optional schema is a small JSON-Schema-flavored subset (see
 * {@link FinalJsonSchema}). It is compiled to a `zod` validator on demand. We
 * do not pull in ajv or a JSON-Schema package because the tree does not carry
 * one and the vision forbids borrowing a dependency where the owned runtime can
 * already do the job (BUILD natively with zod). Anything outside the supported
 * subset is rejected with a precise schema-compile error rather than silently
 * treated as valid, so a bad schema is never a false pass.
 */

/** A single field-level diagnostic produced by validation. */
export interface FinalJsonValidationError {
  /** Dot path into the value; `"root"` for whole-value problems. */
  readonly path: string;
  readonly message: string;
}

/** Result of validating a final-output value. */
export interface FinalJsonValidationResult {
  readonly ok: boolean;
  readonly errors: readonly FinalJsonValidationError[];
}

/**
 * A deliberately small subset of JSON-Schema that zod can compile without a
 * dedicated JSON-Schema engine. Only the listed keywords are honored; unknown
 * keywords are ignored (forward-compatible). `additionalProperties: false` is
 * honored for objects to let callers enforce closed shapes.
 */
export interface FinalJsonSchema {
  readonly type?: FinalJsonType;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly items?: FinalJsonSchema;
  readonly properties?: Readonly<Record<string, FinalJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export type FinalJsonType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

const FinalJsonTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null"
]);

export const FinalJsonSchemaShape: z.ZodType<FinalJsonSchema> = z
  .object({
    type: FinalJsonTypeSchema.optional(),
    const: z.unknown().optional(),
    enum: z.array(z.unknown()).optional(),
    items: z.lazy((): z.ZodType<FinalJsonSchema> => FinalJsonSchemaShape).optional(),
    properties: z
      .record(z.string(), z.lazy((): z.ZodType<FinalJsonSchema> => FinalJsonSchemaShape))
      .optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional()
  })
  .strict() as unknown as z.ZodType<FinalJsonSchema>;

/**
 * Compile a caller-supplied schema description into a `zod` validator.
 *
 * Throws a plain `Error` with a precise message when the schema shape itself is
 * invalid (missing `type`, wrong kind for a keyword, etc.). Callers surface
 * that as a structured error; a schema bug must never look like a valid value.
 */
export function compileFinalJsonSchema(schema: FinalJsonSchema): z.ZodTypeAny {
  const parsed = FinalJsonSchemaShape.safeParse(schema);
  if (!parsed.success) {
    throw new Error(
      `Invalid final-output schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`
    );
  }
  const normalized = parsed.data;

  if (normalized.const !== undefined) {
    return literalFor(normalized.const);
  }

  if (normalized.enum !== undefined) {
    if (normalized.enum.length === 0) {
      throw new Error("Invalid final-output schema: enum must list at least one value.");
    }
    return unionOfLiterals(normalized.enum);
  }

  if (!normalized.type) {
    throw new Error("Invalid final-output schema: type, const, or enum is required.");
  }

  switch (normalized.type) {
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      if (normalized.properties) {
        for (const [key, subschema] of Object.entries(normalized.properties)) {
          const field = compileFinalJsonSchema(subschema);
          shape[key] =
            normalized.required && normalized.required.includes(key) ? field : field.optional();
        }
      }
      const base = z.object(shape);
      return normalized.additionalProperties === false ? base.strict() : base;
    }
    case "array": {
      const itemValidator = normalized.items ? compileFinalJsonSchema(normalized.items) : z.unknown();
      return z.array(itemValidator);
    }
    case "string": {
      let validator = z.string();
      if (normalized.minLength !== undefined) {
        validator = validator.min(normalized.minLength);
      }
      if (normalized.maxLength !== undefined) {
        validator = validator.max(normalized.maxLength);
      }
      return validator;
    }
    case "number": {
      let validator = z.number();
      if (normalized.minimum !== undefined) {
        validator = validator.min(normalized.minimum);
      }
      if (normalized.maximum !== undefined) {
        validator = validator.max(normalized.maximum);
      }
      return validator;
    }
    case "integer": {
      let validator = z.number().int();
      if (normalized.minimum !== undefined) {
        validator = validator.min(normalized.minimum);
      }
      if (normalized.maximum !== undefined) {
        validator = validator.max(normalized.maximum);
      }
      return validator;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default: {
      // Exhaustiveness guard: FinalJsonTypeSchema bounds the values, but keep
      // the validator honest if the union ever widens.
      return z.never();
    }
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): readonly FinalJsonValidationError[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "root",
    message: issue.message
  }));
}

/** Build a literal validator for a single const value of an arbitrary JSON type. */
function literalFor(value: unknown): z.ZodTypeAny {
  if (typeof value === "string") {
    return z.literal(value);
  }
  if (typeof value === "number") {
    return z.literal(value);
  }
  if (typeof value === "boolean") {
    return z.literal(value);
  }
  if (value === null) {
    return z.null();
  }
  // Objects/arrays as const: compare via JSON round-trip equality.
  return z.custom<unknown>(
    (input) => {
      try {
        return JSON.stringify(input) === JSON.stringify(value);
      } catch {
        return false;
      }
    },
    { message: "Value does not match const." }
  );
}

/** Build a union-of-literals validator for an enum, preserving member types. */
function unionOfLiterals(values: readonly unknown[]): z.ZodTypeAny {
  const validators = values.map((value) => literalFor(value));
  return z.union([validators[0]!, ...validators.slice(1)]);
}

/**
 * Validate a final-output value against an optional schema.
 *
 * - No schema: any JSON-compatible value passes (the value must already be a
 *   deserialized JSON value; structural JSON-ness is enforced by zod's passAny
 *   check). A bare value that is not JSON-serializable (functions, symbols,
 *   `undefined`, bigints) fails with a clear root diagnostic.
 * - With schema: the value is compiled-checked against the schema and every
 *   field error is returned with its dot path.
 *
 * Returns `{ ok, errors }` — never throws on bad *values*. Only a bad *schema*
 * throws, because a bad schema is a caller bug, not a model answer to repair.
 */
export function validateFinalJson(
  value: unknown,
  schema?: FinalJsonSchema
): FinalJsonValidationResult {
  const validator = schema ? compileFinalJsonSchema(schema) : jsonValueSchema();
  const result = validator.safeParse(value);

  if (result.success) {
    return { ok: true, errors: [] };
  }

  return { ok: false, errors: formatIssues(result.error.issues) };
}

/**
 * Accept any value that round-trips through `JSON.stringify` without loss and
 * is not `undefined`. This is the "no schema" contract: the final answer must
 * be a real JSON value, even when the caller did not pin a shape.
 */
function jsonValueSchema(): z.ZodTypeAny {
  return z.custom<unknown>(
    (input) => {
      if (input === undefined) {
        return false;
      }
      if (typeof input === "function" || typeof input === "symbol" || typeof input === "bigint") {
        return false;
      }
      try {
        JSON.stringify(input);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Value is not a JSON-serializable value." }
  );
}
