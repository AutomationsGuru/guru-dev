import { z } from "zod";

/**
 * Workflow packs (IDEA-F1, recipe-class, Guru-native): a saved, bounded unit of
 * work — instructions, an optional first prompt, extension/tool allowlists,
 * parameters, an optional model pin, optional outcome checks, and an optional
 * structured final schema — saved under the home profile (`~/.guruharness/packs/`)
 * or a project (`.guru/packs/`) and re-run by the harness's OWN session engine.
 * No third-party agent CLI is ever the pack runtime.
 *
 * v1 file format: JSON. `schemaVersion` pins the shape so future pack versions
 * get an explicit migration instead of silent reinterpretation.
 */

export const WORKFLOW_PACK_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_PACK_FILE_SUFFIX = ".pack.json";

const PackIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, "pack id must be lowercase kebab/dot (a-z0-9 . _ -)");

const CheckExpectSchema = z
  .object({
    /** Expected process exit code (default 0). */
    exitCode: z.number().int().min(0).max(255).optional(),
    /** Substring that must appear in stdout. */
    stdoutContains: z.string().min(1).optional(),
    /** Substring that must NOT appear in stdout. */
    stdoutNotContains: z.string().min(1).optional(),
    /** Substring that must appear in stderr. */
    stderrContains: z.string().min(1).optional()
  })
  .strict();
export type WorkflowPackCheckExpect = z.infer<typeof CheckExpectSchema>;

export const WorkflowPackCheckSchema = z
  .object({
    /** Stable check label for reports (defaults to the joined command). */
    name: z.string().min(1).max(120).optional(),
    /**
     * Shell-free argv (`["npm","test"]`), executed through the harness's owned
     * gate executor (review/gates) — never through a shell line parser.
     */
    command: z.array(z.string().min(1)).min(1),
    expect: CheckExpectSchema.optional(),
    /** Kill the check after this many ms (bounded; defaults applied by the runner). */
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();
export type WorkflowPackCheck = z.infer<typeof WorkflowPackCheckSchema>;

export const WorkflowPackParameterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u, "parameter names must be identifiers"),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    default: z.string().optional()
  })
  .strict();
export type WorkflowPackParameter = z.infer<typeof WorkflowPackParameterSchema>;

export const WorkflowPackSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PACK_SCHEMA_VERSION),
    id: PackIdSchema,
    title: z.string().min(1).max(200),
    /** The standing instruction block for the run (the unit of work, outcome-first). */
    instructions: z.string().min(1),
    /** Optional first prompt sent as the opening user message. */
    prompt: z.string().min(1).optional(),
    parameters: z.array(WorkflowPackParameterSchema).max(64).optional(),
    /** Extension ids the run is allowed to use (absent = no extension restriction declared). */
    extensions: z.array(z.string().min(1)).max(128).optional(),
    /** Tool ids the run is allowed to use (absent = all session tools offered). */
    tools: z.array(z.string().min(1)).max(256).optional(),
    /** Optional model pin: a route/model id the run requests. */
    model: z.string().min(1).max(200).optional(),
    /** Outcome checks run after each attempt; all must pass for the attempt to succeed. */
    checks: z.array(WorkflowPackCheckSchema).max(32).optional(),
    /**
     * Optional structured-output contract (a JSON Schema object). When present,
     * the final assistant message must parse as JSON and satisfy this schema —
     * one validation round-trip, then fail closed.
     */
    responseJsonSchema: z.record(z.string(), z.unknown()).optional(),
    /** Additional attempts after the first when checks or the schema gate fail (default 0, max 5). */
    max_retries: z.number().int().min(0).max(5).optional()
  })
  .strict();
export type WorkflowPack = z.infer<typeof WorkflowPackSchema>;

export const WORKFLOW_PACK_MAX_RETRIES_LIMIT = 5;
