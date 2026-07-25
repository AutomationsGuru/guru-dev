import { z } from "zod";

/**
 * Subagent frontmatter parsed from AGENTS.md blocks (F220 / R-DA-AGENTS-FM).
 *
 * The block is the YAML frontmatter at the very top of an AGENTS.md file,
 * fenced by `---` lines. A subagent is declared when the frontmatter declares
 * a `name`. The `model` is optional and only used when a subagent asks for a
 * non-default model override (F216). `tools` is an optional string[] used to
 * pre-declare which built-in tools the subagent is allowed to invoke — empty
 * means the kernel default applies.
 *
 * Strict parsing: unknown keys are rejected. Missing `name` is a validation
 * failure, not a silent default. The block is the source of truth; junk in,
 * throw out.
 */

const FRONTMATTER_DELIMITER = "---";
const FRONTMATTER_MAX_BYTES = 16 * 1024;
const SUPPORTED_KEYS = ["name", "model", "tools"] as const;

export const AgentsMdSubagentToolSchema = z.string().trim().min(1);
export type AgentsMdSubagentTool = z.infer<typeof AgentsMdSubagentToolSchema>;

export const AgentsMdSubagentFrontmatterSchema = z
  .object({
    name: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    tools: z.array(AgentsMdSubagentToolSchema).optional()
  })
  .strict();
export type AgentsMdSubagentFrontmatter = z.infer<typeof AgentsMdSubagentFrontmatterSchema>;

export interface ParsedAgentsMdSubagent {
  readonly frontmatter: AgentsMdSubagentFrontmatter | null;
  readonly body: string;
  readonly hasFrontmatter: boolean;
}

export interface ParseAgentsMdInput {
  readonly markdown: string;
}

export interface AgentsMdSubagentParseIssue {
  readonly path: string;
  readonly message: string;
}

export class AgentsMdSubagentParseError extends Error {
  readonly issues: ReadonlyArray<AgentsMdSubagentParseIssue>;

  constructor(message: string, issues: ReadonlyArray<AgentsMdSubagentParseIssue>) {
    super(message);
    this.name = "AgentsMdSubagentParseError";
    this.issues = issues;
  }
}

/**
 * Parse a markdown buffer into `{ frontmatter, body, hasFrontmatter }`.
 *
 * Behavior:
 * - Trims a leading UTF-8 BOM and any leading whitespace before looking for
 *   the opening `---` fence.
 * - If the buffer does not start with `---`, returns `hasFrontmatter=false`,
 *   a `null` frontmatter, and the trimmed body. A declarationless AGENTS.md
 *   is not a subagent declaration.
 * - If the buffer starts with `---` but never finds a closing fence, throws
 *   an `AgentsMdSubagentParseError` — a dangling fence is a malformed file,
 *   not a no-frontmatter file.
 * - Otherwise parses the lines between the fences with the line-based YAML
 *   reader that the rest of the harness uses (see `src/skills/loader.ts`).
 *   Only `name`, `model`, and `tools` are honored; unknown keys produce a
 *   validation failure surfaced as `AgentsMdSubagentParseError`.
 *
 * Implementation steps (from the build plan):
 *   1. parse(md).
 *   2. Tests cover valid input and the missing-name rejection path.
 */
export function parseAgentsMdSubagent(input: ParseAgentsMdInput): ParsedAgentsMdSubagent {
  const rawMarkdown = stripUtf8Bom(input.markdown);

  if (rawMarkdown.length > FRONTMATTER_MAX_BYTES) {
    throw new AgentsMdSubagentParseError(
      `AGENTS.md frontmatter exceeds ${FRONTMATTER_MAX_BYTES} bytes.`,
      [{ path: "", message: "frontmatter too large" }]
    );
  }

  const lines = rawMarkdown.split(/\r?\n/);
  const openerIndex = findFrontmatterOpener(lines);

  if (openerIndex < 0) {
    return { frontmatter: null, body: rawMarkdown.trim(), hasFrontmatter: false };
  }

  const closerIndex = findFrontmatterCloser(lines, openerIndex);
  if (closerIndex < 0) {
    throw new AgentsMdSubagentParseError("AGENTS.md frontmatter is missing its closing '---' fence.", [
      { path: "frontmatter", message: "unterminated frontmatter" }
    ]);
  }

  const frontmatterLines = lines.slice(openerIndex + 1, closerIndex);
  const body = lines.slice(closerIndex + 1).join("\n").trim();
  const rawAttributes = parseSimpleFrontmatterLines(frontmatterLines);

  const rejection = rejectUnknownFrontmatterKeys(rawAttributes);
  if (rejection) {
    throw rejection;
  }

  const candidate: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(rawAttributes, "name")) {
    candidate.name = rawAttributes.name;
  }
  if (Object.prototype.hasOwnProperty.call(rawAttributes, "model")) {
    candidate.model = rawAttributes.model;
  }
  if (Object.prototype.hasOwnProperty.call(rawAttributes, "tools")) {
    candidate.tools = coerceToolsList(rawAttributes.tools);
  }

  const result = AgentsMdSubagentFrontmatterSchema.safeParse(candidate);
  if (!result.success) {
    throw new AgentsMdSubagentParseError(
      "AGENTS.md subagent frontmatter failed validation.",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    );
  }

  return {
    frontmatter: result.data,
    body,
    hasFrontmatter: true
  };
}

/**
 * Convenience: build a subagent frontmatter block for tests, builders, and
 * template generators. The inverse of `parseAgentsMdSubagent` — semantically
 * equivalent input yields semantically equivalent output as a deterministic,
 * human-readable string.
 */
export function formatAgentsMdSubagentFrontmatter(frontmatter: AgentsMdSubagentFrontmatter): string {
  AgentsMdSubagentFrontmatterSchema.parse(frontmatter);
  const lines = [FRONTMATTER_DELIMITER, `name: ${frontmatter.name}`];
  if (frontmatter.model !== undefined) {
    lines.push(`model: ${frontmatter.model}`);
  }
  if (frontmatter.tools !== undefined) {
    lines.push(frontmatter.tools.length === 0 ? "tools: []" : `tools: [${frontmatter.tools.join(", ")}]`);
  }
  lines.push(FRONTMATTER_DELIMITER);
  return lines.join("\n");
}

function findFrontmatterOpener(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    return trimmed === FRONTMATTER_DELIMITER ? index : -1;
  }
  return -1;
}

function findFrontmatterCloser(lines: readonly string[], openerIndex: number): number {
  for (let index = openerIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === FRONTMATTER_DELIMITER) {
      return index;
    }
  }
  return -1;
}

function rejectUnknownFrontmatterKeys(attributes: Record<string, unknown>): AgentsMdSubagentParseError | null {
  for (const key of Object.keys(attributes)) {
    if (!SUPPORTED_KEYS.includes(key as (typeof SUPPORTED_KEYS)[number])) {
      return new AgentsMdSubagentParseError(
        `AGENTS.md frontmatter uses unsupported key '${key}'. Expected one of: ${SUPPORTED_KEYS.join(", ")}.`,
        [{ path: key, message: `unknown frontmatter key '${key}'` }]
      );
    }
  }
  return null;
}

function coerceToolsList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === "string" ? entry : String(entry)));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new AgentsMdSubagentParseError("AGENTS.md frontmatter 'tools' entry is not a list.", [
        { path: "tools", message: "expected a list, got an empty scalar" }
      ]);
    }
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      throw new AgentsMdSubagentParseError("AGENTS.md frontmatter 'tools' entry is not a list.", [
        { path: "tools", message: `expected a list, got scalar '${trimmed}'` }
      ]);
    }
    return splitCommaSeparatedList(trimmed.slice(1, -1));
  }
  throw new AgentsMdSubagentParseError("AGENTS.md frontmatter 'tools' entry is not a list.", [
    { path: "tools", message: `expected a list, got ${typeof raw}` }
  ]);
}

function parseSimpleFrontmatterLines(lines: readonly string[]): Record<string, unknown> {
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
    attributes[key] = parseFrontmatterScalar(key, value);
  }

  return attributes;
}

function parseFrontmatterScalar(key: string, rawValue: string): string | string[] {
  const value = stripSurroundingQuotes(rawValue);

  if (value.startsWith("[") && value.endsWith("]")) {
    return splitCommaSeparatedList(value.slice(1, -1));
  }

  if (key === "tools") {
    return value;
  }

  return value;
}

function splitCommaSeparatedList(value: string): string[] {
  return value.split(",").map((entry) => stripSurroundingQuotes(entry.trim()));
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const head = trimmed.charAt(0);
    const tail = trimmed.charAt(trimmed.length - 1);
    if ((head === "\"" && tail === "\"") || (head === "'" && tail === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function stripUtf8Bom(markdown: string): string {
  return markdown.length > 0 && markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
}
