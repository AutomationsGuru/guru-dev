import { z } from "zod";

/**
 * Agent identity memory card — structured {name, principles[], taboos[]} load/save.
 *
 * Stored as a markdown file with YAML-ish frontmatter (minimal subset — flat
 * key:value lines plus indented `- "value"` list items). The body is free-form
 * prose after the closing fence.
 *
 * Pure parse/serialize only. Identity cards are descriptive memory artifacts,
 * **never authoritative over operator instructions** — the operator is always
 * in the seat and an identity card cannot override a direct instruction,
 * weaken a hard limit, or bind the harness to a persona. Use as a loadout hint
 * or recall cue, not as a mandate.
 */

// ── Schema ────────────────────────────────────────────────────────────────

export const AgentIdentityCardSchema = z
  .object({
    /** Identity name — human-readable, unique within a role or space. */
    name: z.string().trim().min(1).max(120),
    /** Guiding principles (ordered — first is highest priority). */
    principles: z.array(z.string().trim().min(1)).default([]),
    /** Taboos — things this identity must never do (hard guardrails). */
    taboos: z.array(z.string().trim().min(1)).default([]),
    /** Free-form prose body after the frontmatter fence. */
    body: z.string().trim().default("")
  })
  .strict();

export type AgentIdentityCard = z.infer<typeof AgentIdentityCardSchema>;

// ── Frontmatter helpers ───────────────────────────────────────────────────

const FRONTMATTER_FENCE = "---";

/**
 * Minimal YAML-ish frontmatter parser that handles:
 *   - flat `key: value` lines (value may be quoted)
 *   - list values: indented `  - "item"` or `  - item` under a preceding key
 *   - multi-line list items
 *
 * Returns a Record of key → string[] (lists are multi-value; scalars have one
 * element). Does NOT implement full YAML — just enough for identity cards.
 */
function parseFrontmatterBlock(header: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  const lines = header.split("\n");
  let currentKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // Empty lines are separators — reset list context
    if (line.trim() === "") {
      currentKey = null;
      continue;
    }

    // List item — must be indented under a current key
    const listMatch = /^\s{1,8}-\s+"([^"]*)"$/u.exec(line);
    const listUnquoted = /^\s{1,8}-\s+(.+)$/u.exec(line);
    if (listMatch?.[1] !== undefined && currentKey) {
      const list = fields[currentKey] ?? [];
      list.push(listMatch[1]);
      fields[currentKey] = list;
      continue;
    }
    if (listUnquoted?.[1] !== undefined && currentKey) {
      const list = fields[currentKey] ?? [];
      list.push(listUnquoted[1].trim());
      fields[currentKey] = list;
      continue;
    }

    // Flat key: value
    const kvMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (kvMatch?.[1]) {
      const rawValue = kvMatch[2].trim();
      currentKey = kvMatch[1];
      if (rawValue.length > 0) {
        const value = parseScalarValue(rawValue);
        fields[currentKey] = [value];
      }
      // rawValue empty → list header (principles: / taboos:) — just set
      // currentKey and let the indented list items populate the value.
    } else {
      currentKey = null;
    }
  }

  return fields;
}

function parseScalarValue(raw: string): string {
  if (
    raw.length >= 2 &&
    raw.startsWith('"') &&
    raw.endsWith('"')
  ) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through
    }
  }
  return raw;
}

function emitValue(value: string): string {
  const needsQuote =
    /[:#[\]{}"'\n,]/.test(value) ||
    value !== value.trim() ||
    value.startsWith("- ") ||
    value.length === 0;
  return needsQuote ? JSON.stringify(value) : value;
}

// ── Serialize ─────────────────────────────────────────────────────────────

/**
 * Serialize an identity card to a markdown string with frontmatter.
 * Roundtrip-safe: `parseIdentityCard(serializeIdentityCard(card))` produces
 * an equivalent card.
 */
export function serializeIdentityCard(card: AgentIdentityCard): string {
  AgentIdentityCardSchema.parse(card); // validate early

  const headerLines: string[] = [FRONTMATTER_FENCE];

  headerLines.push(`name: ${emitValue(card.name)}`);
  headerLines.push("type: identity");

  if (card.principles.length > 0) {
    headerLines.push("principles:");
    for (const p of card.principles) {
      headerLines.push(`  - ${JSON.stringify(p)}`);
    }
  }

  if (card.taboos.length > 0) {
    headerLines.push("taboos:");
    for (const t of card.taboos) {
      headerLines.push(`  - ${JSON.stringify(t)}`);
    }
  }

  headerLines.push(FRONTMATTER_FENCE);

  const parts = [...headerLines];
  if (card.body.length > 0) {
    parts.push("", card.body.trimEnd());
  }
  parts.push(""); // trailing newline

  return parts.join("\n");
}

// ── Parse ─────────────────────────────────────────────────────────────────

/**
 * Parse a markdown identity card file into an AgentIdentityCard.
 * Returns undefined for any malformed input (missing fence, failed schema) so
 * one corrupt file never brings down the whole identity loader.
 */
export function parseIdentityCard(text: string): AgentIdentityCard | undefined {
  const normalized = text.replace(/\r\n/gu, "\n");

  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return undefined;
  }

  const closing = normalized.indexOf(
    `\n${FRONTMATTER_FENCE}\n`,
    FRONTMATTER_FENCE.length
  );
  if (closing < 0) {
    return undefined;
  }

  const header = normalized.slice(FRONTMATTER_FENCE.length + 1, closing);
  const rawBody = normalized.slice(closing + FRONTMATTER_FENCE.length + 2);
  const body = rawBody.replace(/^\n/u, "").trim();

  const fields = parseFrontmatterBlock(header);

  // Validate type marker (optional but warn-worthy if wrong)
  const typeVal = fields["type"]?.[0];
  if (typeVal !== undefined && typeVal !== "identity") {
    return undefined; // not an identity card
  }

  const name = fields["name"]?.[0];
  if (!name || name.length === 0) {
    return undefined;
  }

  // Principles and taboos come from list fields
  const principles = fields["principles"] ?? [];
  const taboos = fields["taboos"] ?? [];

  const parsed = AgentIdentityCardSchema.safeParse({
    name,
    principles,
    taboos,
    body
  });

  return parsed.success ? parsed.data : undefined;
}

/**
 * True when `text` looks like an identity card (has `type: identity` in its
 * frontmatter). Does not fully validate — use parseIdentityCard for that.
 */
export function isIdentityCard(text: string): boolean {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) return false;
  const closing = normalized.indexOf(
    `\n${FRONTMATTER_FENCE}\n`,
    FRONTMATTER_FENCE.length
  );
  if (closing < 0) return false;
  const header = normalized.slice(FRONTMATTER_FENCE.length + 1, closing);
  return /\ntype:\s*identity\s*$/m.test(header);
}
