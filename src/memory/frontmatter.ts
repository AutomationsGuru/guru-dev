import { MemoryFactSchema, type MemoryFact } from "./schemas.js";

/**
 * Minimal Obsidian-standard frontmatter for memory facts (no YAML dependency —
 * the same hand-rolled subset the skills loader proves). Emitted keys are plain
 * `key: value` lines so Obsidian renders them as Properties; `tags` is emitted
 * for Obsidian tag panes but derived from `type` (never stored on the fact).
 */

const FRONTMATTER_FENCE = "---";

export interface ParsedFactFile {
  readonly fact: MemoryFact;
  readonly body: string;
}

function needsQuoting(value: string): boolean {
  return /[:#[\]{}"'\n]/u.test(value) || value !== value.trim();
}

function emitValue(value: string): string {
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // fall through to raw
    }
  }
  return trimmed;
}

export function serializeFactFile(fact: MemoryFact, body: string): string {
  const lines = [
    FRONTMATTER_FENCE,
    `name: ${fact.name}`,
    `title: ${emitValue(fact.title)}`,
    `description: ${emitValue(fact.description)}`,
    `type: ${fact.type}`,
    `createdAt: ${fact.createdAt}`,
    `updatedAt: ${fact.updatedAt}`,
    `confidence: ${fact.confidence}`,
    ...(fact.originSessionId ? [`originSessionId: ${fact.originSessionId}`] : []),
    `tags: [memory/${fact.type}]`,
    FRONTMATTER_FENCE,
    "",
    body.trimEnd(),
    ""
  ];
  return lines.join("\n");
}

/**
 * Parses a fact file. Returns undefined on any malformed input (missing fence,
 * failed schema) — callers skip-and-report rather than throw, so one corrupt
 * file never takes down the whole memory.
 */
export function parseFactFile(text: string): ParsedFactFile | undefined {
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

  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      fields[match[1]] = parseValue(match[2]);
    }
  }

  const confidenceRaw = fields["confidence"];
  const parsed = MemoryFactSchema.safeParse({
    name: fields["name"],
    title: fields["title"],
    description: fields["description"],
    type: fields["type"],
    createdAt: fields["createdAt"],
    updatedAt: fields["updatedAt"],
    ...(confidenceRaw !== undefined && confidenceRaw.length > 0 && !Number.isNaN(Number(confidenceRaw))
      ? { confidence: Number(confidenceRaw) }
      : {}),
    ...(fields["originSessionId"] ? { originSessionId: fields["originSessionId"] } : {})
  });

  return parsed.success ? { fact: parsed.data, body: body.trimEnd() } : undefined;
}

/** Extracts [[wiki-link]] targets from a fact body (deduped, order-preserving). */
export function extractLinks(body: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(/\[\[([a-z0-9][a-z0-9-]{1,62}[a-z0-9])\]\]/gu)) {
    if (match[1]) {
      seen.add(match[1]);
    }
  }
  return [...seen];
}
