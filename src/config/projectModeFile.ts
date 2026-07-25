import { z } from "zod";

/**
 * Project mode file loader (`.guru/mode.md`).
 *
 * A project mode file is a Markdown document whose leading YAML-style
 * frontmatter declares the project's mode identity, e.g.:
 *
 * ```
 * ---
 * mode: code-review
 * description: Project runs in review-only lane.
 * ---
 *
 * # Mode notes
 * …
 * ```
 *
 * The loader parses the frontmatter and resolves the mode id WITHOUT executing
 * any tool — it is a pure, read-only text transform. This is the same hand-rolled
 * frontmatter subset proven by the memory and skills loaders (no YAML dependency
 * is pulled into core), validated through `zod` so a malformed or modeless file
 * fails structurally rather than silently.
 *
 * Inputs/outputs here are project-owned; no external product is rehosted and no
 * secret is ever read for content.
 */

const FRONTMATTER_FENCE = "---";

/**
 * A mode id is a stable lowercase kebab-case identifier (mirrors the kebab-case
 * convention used for skills, mandates, and roles across the harness). It must
 * not be empty — a mode file without a resolvable mode fails by design.
 */
const MODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const ProjectModeFileSchema = z
  .object({
    /** Resolved mode identity for the project (e.g. `code-review`, `build`, `ship`). */
    mode: z.string().trim().min(1).regex(MODE_ID_PATTERN, "mode must be lowercase kebab-case"),
    /** Human-readable note; optional, never used as a control signal. */
    description: z.string().trim().optional()
  })
  .strict();

export type ProjectModeFile = z.infer<typeof ProjectModeFileSchema>;

/** A successfully parsed `.guru/mode.md` — the body is returned but never executed. */
export interface ParsedModeFile {
  readonly ok: true;
  readonly modeId: string;
  readonly frontmatter: ProjectModeFile;
  /** The Markdown body following the frontmatter (trimmed); carried, not run. */
  readonly body: string;
}

/** A rejected `.guru/mode.md` — `reason` names the structural failure precisely. */
export interface ModeFileRejection {
  readonly ok: false;
  readonly reason: string;
}

export type ParseModeFileResult = ParsedModeFile | ModeFileRejection;

/** A normalized frontmatter split: the inner header block plus the trailing body. */
interface SplitFrontmatter {
  readonly header: string;
  readonly body: string;
}

/**
 * Split a `---`-delimited frontmatter block from the document body without
 * executing any tool. Returns undefined when the fence is absent or never closes
 * (matches the memory loader's tolerant-skip contract).
 */
function splitFrontmatter(text: string): SplitFrontmatter | undefined {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return undefined;
  }
  const closing = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (closing < 0) {
    return undefined;
  }
  const header = normalized.slice(FRONTMATTER_FENCE.length + 1, closing);
  const body = normalized.slice(closing + FRONTMATTER_FENCE.length + 2).replace(/^\n/u, "");
  return { header, body };
}

/** Parse a `key: value` header block into a plain object (hand-rolled YAML subset). */
function parseHeader(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      const raw = match[2].trim();
      // Strip a single pair of surrounding double quotes if present.
      fields[match[1]] = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    }
  }
  return fields;
}

/**
 * Parse a `.guru/mode.md` document and resolve its mode id.
 *
 * Pure: no filesystem, no process, no tool execution — the operator's text is
 * transformed in place. A file missing the frontmatter, missing the `mode` key,
 * or carrying a non-kebab-case mode id fails with a precise `reason`.
 */
export function parseModeFile(text: string): ParseModeFileResult {
  const split = splitFrontmatter(text);
  if (!split) {
    return { ok: false, reason: "Project mode file is missing frontmatter (expected a leading '---' fence)." };
  }

  const fields = parseHeader(split.header);
  if (fields["mode"] === undefined || fields["mode"].length === 0) {
    return { ok: false, reason: "Project mode file is missing the required 'mode' frontmatter field." };
  }

  const parsed = ProjectModeFileSchema.safeParse({
    mode: fields["mode"],
    ...(fields["description"] !== undefined ? { description: fields["description"] } : {})
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `Invalid project mode file: ${first?.message ?? "validation failed"}.` };
  }

  return {
    ok: true,
    modeId: parsed.data.mode,
    frontmatter: parsed.data,
    body: split.body.trimEnd()
  };
}
