/**
 * Steering inclusion schema + front-matter parser (IDEA-F137-STEERING-INCL-01).
 *
 * Steering docs are markdown files with YAML-style front-matter describing
 * how they should be included for a given context. The `mode` field selects
 * one of four inclusion rules: always / fileMatch / manual / auto. The
 * companion resolver in `steeringInclusion.ts` decides which docs apply for
 * a given `(activePath?, userQuery?, manualRefs[])` context.
 *
 * The front-matter parser is intentionally minimal: scalar values, simple
 * `[a, b, c]` array values, and `key: value` lines. It tolerates a missing
 * opener or closer by returning an empty front-matter object and the full
 * content as the body.
 */
import { z } from "zod";

export interface ParsedFrontMatter {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * Parse a YAML-style front-matter block delimited by `---` lines.
 *
 * The opener must be the first line of the content; the closer may appear on
 * any subsequent line. If either is missing, the entire content is treated as
 * the body (with no front-matter attributes).
 */
export function parseFrontMatter(content: string): ParsedFrontMatter {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const lines = content.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (closingIndex < 0) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n");

  return {
    frontmatter: parseSimpleYamlFrontmatter(frontmatterLines),
    body
  };
}

function parseSimpleYamlFrontmatter(lines: readonly string[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const delimiterIndex = trimmed.indexOf(":");
    if (delimiterIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, delimiterIndex).trim();
    const value = trimmed.slice(delimiterIndex + 1).trim();
    attributes[key] = parseFrontmatterValue(value);
  }

  return attributes;
}

function parseFrontmatterValue(value: string): string | string[] {
  const unquoted = stripQuotes(value);

  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    return splitCommaSeparatedList(unquoted.slice(1, -1));
  }

  return unquoted;
}

function splitCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0);
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export const InclusionModeSchema = z.enum(["always", "fileMatch", "manual", "auto"]);
export type InclusionMode = z.infer<typeof InclusionModeSchema>;

export const SteeringDocSchema = z
  .object({
    id: z.string().trim().min(1),
    path: z.string().trim().min(1).optional(),
    content: z.string(),
    body: z.string().default(""),
    description: z.string().optional(),
    fileMatch: z.array(z.string().trim().min(1)).optional(),
    mode: InclusionModeSchema.default("manual")
  })
  .strict();
export type SteeringDoc = z.infer<typeof SteeringDocSchema>;

export const SteeringContextSchema = z
  .object({
    activePath: z.string().trim().min(1).optional(),
    userQuery: z.string().optional(),
    manualRefs: z.array(z.string().trim().min(1)).optional().default([])
  })
  .strict();
export type SteeringContext = z.output<typeof SteeringContextSchema>;
export type SteeringContextInput = z.input<typeof SteeringContextSchema>;

export const ResolvedSteeringEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    mode: InclusionModeSchema,
    content: z.string(),
    body: z.string(),
    reason: z.string().trim().min(1)
  })
  .strict();

export const ResolvedSteeringSchema = z
  .object({
    selected: z.array(ResolvedSteeringEntrySchema)
  })
  .strict();
export type ResolvedSteering = z.infer<typeof ResolvedSteeringSchema>;