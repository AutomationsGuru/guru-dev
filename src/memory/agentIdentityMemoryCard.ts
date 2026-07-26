import { z } from "zod";

/**
 * Descriptive, durable identity memory only. Callers must never treat a card as
 * authority over operator instructions, mandates, or hard limits.
 */
export const AgentIdentityCardSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    principles: z.array(z.string().trim().min(1)).default([]),
    taboos: z.array(z.string().trim().min(1)).default([]),
    body: z.string().default("")
  })
  .strict();

export type AgentIdentityCard = z.infer<typeof AgentIdentityCardSchema>;

const FRONTMATTER_FENCE = "---";

function needsQuoting(value: string): boolean {
  return /[:#[\]{}"'\n]/u.test(value) || value !== value.trim();
}

function serializeValue(value: string): string {
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
      // Preserve unquoted or malformed values for schema validation.
    }
  }
  return trimmed;
}

function splitFrontmatter(text: string): { header: string; body: string } | undefined {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return undefined;
  }

  const closing = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  const terminalClosing = normalized.endsWith(`\n${FRONTMATTER_FENCE}`) ? normalized.length - FRONTMATTER_FENCE.length - 1 : -1;
  const closingIndex = closing >= 0 ? closing : terminalClosing;
  if (closingIndex < 0) {
    return undefined;
  }

  const bodyStart = closingIndex + FRONTMATTER_FENCE.length + 1;
  return {
    header: normalized.slice(FRONTMATTER_FENCE.length + 1, closingIndex),
    body: normalized.slice(bodyStart).replace(/^\n/u, "").trimEnd()
  };
}

function parseHeader(header: string): { fields: Record<string, string>; lists: Record<string, string[]> } {
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let activeList: string | undefined;

  for (const line of header.split("\n")) {
    const listItem = /^\s+-\s+(.*)$/u.exec(line);
    if (listItem?.[1] !== undefined && activeList) {
      lists[activeList]?.push(parseValue(listItem[1]));
      continue;
    }

    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!field?.[1] || field[2] === undefined) {
      activeList = undefined;
      continue;
    }

    const [, key, rawValue] = field;
    if (rawValue.length === 0) {
      lists[key] = [];
      activeList = key;
    } else {
      fields[key] = parseValue(rawValue);
      activeList = undefined;
    }
  }

  return { fields, lists };
}

/** Serializes a descriptive identity card as portable Markdown frontmatter. */
export function serializeIdentityCard(input: AgentIdentityCard): string {
  const card = AgentIdentityCardSchema.parse(input);
  const lines = [
    FRONTMATTER_FENCE,
    "type: identity",
    `name: ${serializeValue(card.name)}`,
    ...(card.principles.length > 0 ? ["principles:", ...card.principles.map((item) => `  - ${JSON.stringify(item)}`)] : []),
    ...(card.taboos.length > 0 ? ["taboos:", ...card.taboos.map((item) => `  - ${JSON.stringify(item)}`)] : []),
    FRONTMATTER_FENCE,
    "",
    card.body.trimEnd(),
    ""
  ];
  return lines.join("\n");
}

/** Parses a descriptive card; malformed or explicitly non-identity files are skipped. */
export function parseIdentityCard(text: string): AgentIdentityCard | undefined {
  const split = splitFrontmatter(text);
  if (!split) {
    return undefined;
  }

  const { fields, lists } = parseHeader(split.header);
  if (fields["type"] !== undefined && fields["type"] !== "identity") {
    return undefined;
  }

  const parsed = AgentIdentityCardSchema.safeParse({
    name: fields["name"],
    principles: lists["principles"] ?? [],
    taboos: lists["taboos"] ?? [],
    body: split.body
  });
  return parsed.success ? parsed.data : undefined;
}

/** Returns true only when frontmatter explicitly identifies a card as `identity`. */
export function isIdentityCard(text: string): boolean {
  const split = splitFrontmatter(text);
  if (!split) {
    return false;
  }
  return parseHeader(split.header).fields["type"] === "identity";
}
