import { z } from "zod";

// ── Field type discriminant ──────────────────────────────────

export const TaskOutputFieldTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "array",
  "object",
]);
export type TaskOutputFieldType = z.infer<typeof TaskOutputFieldTypeSchema>;

// ── Single declared output field ─────────────────────────────

export const TaskOutputFieldDeclSchema = z
  .object({
    name: z.string().trim().min(1),
    type: TaskOutputFieldTypeSchema,
    required: z.boolean().default(true),
  })
  .strict();
export type TaskOutputFieldDecl = z.infer<typeof TaskOutputFieldDeclSchema>;

// ── Output schema: a collection of declared fields ───────────

export const StructuredTaskOutputSchemaDefSchema = z
  .object({
    fields: z.array(TaskOutputFieldDeclSchema).min(1),
  })
  .strict();
export type StructuredTaskOutputSchemaDef = z.infer<
  typeof StructuredTaskOutputSchemaDefSchema
>;

// ── Validation error ─────────────────────────────────────────

export const TaskOutputValidationErrorSchema = z
  .object({
    field: z.string().trim().min(1),
    message: z.string().trim().min(1),
  })
  .strict();
export type TaskOutputValidationError = z.infer<
  typeof TaskOutputValidationErrorSchema
>;

// ── Validation result ────────────────────────────────────────

export const TaskOutputValidationResultSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(TaskOutputValidationErrorSchema),
  })
  .strict();
export type TaskOutputValidationResult = z.infer<
  typeof TaskOutputValidationResultSchema
>;

// ── validate(output, schema) ──────────────────────────────────

/**
 * Validate an output value against a declared field schema.
 *
 * Checks that every required field is present and that the runtime type
 * of each present value matches its declared type.  Optional-but-missing
 * fields and extra undeclared fields are not errors.
 */
export function validate(
  output: unknown,
  schema: StructuredTaskOutputSchemaDef,
): TaskOutputValidationResult {
  if (typeof output !== "object" || output === null) {
    return {
      valid: false,
      errors: [
        {
          field: "(root)",
          message: "Output must be a non-null object.",
        },
      ],
    };
  }

  const outRecord = output as Record<string, unknown>;
  const errors: TaskOutputValidationError[] = [];

  for (const field of schema.fields) {
    const value = outRecord[field.name];
    const isMissing = value === undefined;

    if (field.required && isMissing) {
      errors.push({
        field: field.name,
        message: `Missing required field "${field.name}".`,
      });
      continue;
    }

    if (isMissing) {
      continue; // optional field absent — no error
    }

    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== field.type) {
      errors.push({
        field: field.name,
        message: `Type mismatch for "${field.name}": expected ${field.type}, got ${actualType}.`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
