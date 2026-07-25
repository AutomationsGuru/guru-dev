import { z, type ZodType } from "zod";

import type { ToolDefinition, ToolRegistry } from "./registry.js";

/**
 * Speculative tool preview (IDEA-F389-SPECUL-01, R-OD-SPECUL).
 *
 * Pure, side-effect-free dry-run description of what a tool *would* do,
 * WITHOUT executing it. The preview never runs the tool, never touches the
 * filesystem, and never delegates to the tool's own `execute` — it reads only
 * the tool's static definition (id, description, declared `effect`, input
 * schema) plus the caller-supplied args. This is the "describe the effect
 * before paying for it" surface: read-only by construction, registered
 * capability (no core edit), and structural (no prompt-only rule).
 *
 * The five hard limits are untouched: this module never mutates anything and
 * never holds secrets (args may be redacted by the caller; values are not
 * assumed to be safe and are surfaced only as opaque `string`).
 */

export const SpeculativePreviewInputSchema = z
  .object({
    toolName: z.string().trim().min(1).describe("Registered tool id to preview."),
    args: z.record(z.string(), z.unknown()).describe("Arguments the tool would be invoked with.")
  })
  .strict();

export const SpeculativePreviewOutputSchema = z
  .object({
    toolName: z.string(),
    recognized: z.boolean(),
    effect: z.enum(["read-only", "mutating", "unknown"]),
    wouldExecute: z.boolean(),
    description: z.string(),
    notes: z.array(z.string())
  })
  .strict();

export type SpeculativePreviewInput = z.infer<typeof SpeculativePreviewInputSchema>;
export type SpeculativePreviewOutput = z.infer<typeof SpeculativePreviewOutputSchema>;

/**
 * Resolves a tool definition from either a registry or an explicit definition.
 * Kept synchronous on purpose: the preview must not require execution.
 */
function resolveTool(
  source: ToolRegistry | ToolDefinition | undefined,
  toolName: string
): ToolDefinition | undefined {
  if (!source) {
    return undefined;
  }
  if (typeof (source as ToolRegistry).get === "function") {
    return (source as ToolRegistry).get(toolName);
  }
  const definition = source as ToolDefinition;
  return definition.id === toolName ? definition : undefined;
}

/**
 * Best-effort per-tool effect description built from args alone. The args map
 * is read structurally (presence + length) — values are coerced to opaque
 * strings and never persisted, printed, or assumed secret-free by callers.
 *
 * Returns `null` for tools with no canned description; the caller falls back to
 * the tool's declared `effect` + static description.
 */
function describeKnownTool(toolName: string, args: Readonly<Record<string, unknown>>): string | null {
  const arg = (key: string): unknown => args[key];
  const str = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
  };
  const has = (key: string): boolean => key in args && args[key] !== undefined;

  switch (toolName) {
    case "write":
    case "pi_write": {
      const path = str("path") ?? "<unspecified path>";
      const overwrite = arg("overwrite") === true;
      const dryRun = arg("dryRun") !== false; // mirrors writeTool default
      const bytes =
        typeof arg("contents") === "string"
          ? Buffer.byteLength(arg("contents") as string, "utf8")
          : undefined;
      return [
        `Would write file at ${path}.`,
        overwrite ? "Overwrite flag set; an existing file would be replaced." : "Would NOT overwrite an existing file.",
        dryRun ? "dryRun is on by default — no bytes would be written unless dryRun=false." : "dryRun=false — bytes would be written.",
        bytes === undefined ? "Contents not a string; byte count unknown." : `Approximately ${bytes} byte(s).`
      ].join(" ");
    }
    case "file_edit":
    case "exact_edit": {
      const path = str("path") ?? str("file") ?? "<unspecified path>";
      return `Would edit file ${path} in place by replacing matched text. No description of the resulting content is generated without executing the tool.`;
    }
    case "bash":
    case "shell_exec": {
      const command =
        (typeof arg("command") === "string" && (arg("command") as string)) ||
        (Array.isArray(arg("command")) && (arg("command") as unknown[]).join(" ")) ||
        str("script") ||
        "<unspecified command>";
      return `Would execute a shell command (${command.trim().slice(0, 80) || "opaque"}). The preview cannot know the command's real effect; treat as mutating and potentially destructive.`;
    }
    case "read":
    case "read_diagnostics":
    case "search":
    case "glob":
    case "grep":
    case "repo_context": {
      return `Would read repository/process state only (${toolName}). No mutation expected.`;
    }
    default:
      return null;
  }
}

function validateArgs(definition: ToolDefinition, args: Readonly<Record<string, unknown>>): z.infer<typeof SpeculativePreviewOutputSchema>["notes"] {
  const notes: string[] = [];
  const schema = definition.inputSchema as ZodType;
  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "root"}: ${issue.message}`)
      .join("; ");
    notes.push(`Args do not satisfy the tool input schema (${issues}). The tool would fail at the input gate if executed.`);
  }
  return notes;
}

/**
 * Produce a speculative preview of a tool's effect.
 *
 * @param source   A registry, a single tool definition, or undefined.
 * @param toolName The tool id to preview.
 * @param args     The args the tool would be invoked with.
 * @returns A read-only description. Never executes the tool.
 */
export function previewToolEffect(
  source: ToolRegistry | ToolDefinition | undefined,
  toolName: string,
  args: Readonly<Record<string, unknown>>
): SpeculativePreviewOutput {
  const definition = resolveTool(source, toolName);
  const recognized = Boolean(definition);

  if (!definition) {
    return {
      toolName,
      recognized: false,
      effect: "unknown",
      wouldExecute: false,
      description:
        `Tool "${toolName}" is not registered. No effect can be described; executing it would fail with "tool not registered".`,
      notes: ["Unknown tool — no static definition available."]
    };
  }

  const declaredEffect = definition.effect ?? "unknown";
  const notes = validateArgs(definition, args);
  const known = describeKnownTool(toolName, args);
  const description =
    known ??
    `${definition.description || `Tool "${toolName}".`} Preview is based only on the tool's declared effect (${declaredEffect}); the actual effect is not computed without executing the tool.`;

  return {
    toolName,
    recognized: true,
    effect: declaredEffect,
    wouldExecute: false,
    description,
    notes
  };
}

/**
 * Convenience: describe a tool effect from raw preview input (validated).
 */
export function previewFromInput(
  source: ToolRegistry | ToolDefinition | undefined,
  input: SpeculativePreviewInput
): SpeculativePreviewOutput {
  return previewToolEffect(source, input.toolName, input.args);
}
