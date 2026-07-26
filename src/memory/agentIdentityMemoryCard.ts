import { z } from "zod";

/**
 * Agent Identity Memory Card — structured {name, principles[], taboos[]}
 * load/save pure (Foundation Wave IDEA-F415, 2026-07-19).
 *
 * An identity card describes what an agent *is* when it operates in a given
 * role or space. It is a **descriptive memory artifact** — never authoritative
 * over operator instructions, never a substitute for the constitution or hard
 * limits, and never loaded as a runtime override. The agent's actual behavior
 * is governed by its session prompt, the constitution, and operator directives;
 * the identity card is a durable record the agent can consult to stay aligned
 * with its declared identity across sessions.
 *
 * Storage: one markdown file per identity card, with YAML-ish frontmatter
 * (hand-rolled subset — no yaml dependency). The file is a valid Obsidian
 * note by construction. The `type: identity` marker distinguishes identity
 * cards from other memory facts.
 *
 * Constraint: identity cards live in the memory card space. They are NOT
 * loaded by the policy engine, the mandate evaluator, or the YOLO resolver.
 * If an identity card conflicts with an operator instruction, the operator
 * wins — always.
 */

// ── schema ──────────────────────────────────────────────────────────────────

export const AgentIdentityCardSchema = z
  .object({
    /** Agent display name — plain text, 1-120 chars. */
    name: z.string().trim().min(1).max(120),
    /**
     * Principles the agent is meant to follow. Descriptive guidance, never
     * authoritative over operator instructions or the constitution.
     */
    principles: z
      .array(z.string().trim().min(1))
      .default([]),
    /**
     * Taboos — things the agent should never do. Descriptive guardrails,
     * enforced by the constitution and hard limits, not by this card.
     */
    taboos: z
      .array(z.string().trim().min(1))
      .default([]),
    /** Free-form body — narrative identity description, role context, etc. */
    body: z.string().trim().default("")
  })
  .strict();

export type AgentIdentityCard = z.infer<typeof AgentIdentityCardSchema>;

// ── serialization ───────────────────────────────────────────────────────────

const FRONTMATTER_FENCE = "---";

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

/**
 * Serialize an AgentIdentityCard to a markdown file with frontmatter.
 * Always emits LF line endings. List items (principles, taboos) are always
 * JSON-quoted for roundtrip safety; scalar values are quoted only when they
 * contain special characters.
 */
export function serializeIdentityCard(card: AgentIdentityCard): string {
  // Validate before serializing.
  const validated = AgentIdentityCardSchema.parse(card);

  const lines: string[] = [FRONTMATTER_FENCE];

  lines.push(`name: ${emitValue(validated.name)}`);
  lines.push("type: identity");

  if (validated.principles.length > 0) {
    lines.push("principles:");
    for (const p of validated.principles) {
      // Always quote list items for roundtrip safety — some principles
      // contain colons, hashes, or other special chars.
      lines.push(`  - ${JSON.stringify(p)}`);
    }
  }

  if (validated.taboos.length > 0) {
    lines.push("taboos:");
    for (const t of validated.taboos) {
      lines.push(`  - ${JSON.stringify(t)}`);
    }
  }

  lines.push(FRONTMATTER_FENCE);

  // Body after an empty separator line, or just the body if empty is ok.
  // Always include a blank line before body.
  lines.push("");
  if (validated.body.length > 0) {
    lines.push(validated.body);
  }

  // Trailing newline.
  return `${lines.join("\n")}\n`;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Parses an identity card markdown file. Returns undefined on any malformed
 * input: missing fence, invalid schema, non-identity type (when explicit),
 * or empty name.
 *
 * Permissive on missing type marker — if the file has a valid identity-card
 * shape without `type: identity`, it is still accepted. This allows cards
 * written by older tooling or hand-edited files to parse correctly.
 */
export function parseIdentityCard(text: string): AgentIdentityCard | undefined {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return undefined;
  }

  const closingIdx = normalized.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
  if (closingIdx < 0) {
    return undefined;
  }

  const headerText = normalized.slice(FRONTMATTER_FENCE.length + 1, closingIdx);
  const body = normalized.slice(closingIdx + FRONTMATTER_FENCE.length + 1);

  // Parse frontmatter into field → raw value or list items.
  const fields: Record<string, string> = {};
  const listFields: Record<string, string[]> = {};
  let currentList: string | null = null;

  for (const rawLine of headerText.split("\n")) {
    const line = rawLine.trimEnd();

    // List item continuation.
    if (currentList) {
      const listMatch = /^\s*-\s+(.*)$/u.exec(line);
      if (listMatch) {
        const item = parseValue(listMatch[1].trim());
        if (item.length > 0) {
          (listFields[currentList] ??= []).push(item);
        }
        continue;
      }
      // Not a list item — close the current list.
      currentList = null;
      // Fall through to try key: value.
    }

    // List header (key: with no value, followed by indented items).
    const listHeaderMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*$/u.exec(line);
    if (listHeaderMatch?.[1]) {
      currentList = listHeaderMatch[1];
      listFields[currentList] = [];
      continue;
    }

    // Scalar key: value.
    const scalarMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (scalarMatch?.[1] && scalarMatch[2] !== undefined) {
      fields[scalarMatch[1]] = parseValue(scalarMatch[2]);
      continue;
    }
  }

  // If the type is explicitly present and not "identity", reject.
  if (fields["type"] !== undefined && fields["type"] !== "identity") {
    return undefined;
  }

  // Name is required.
  const name = fields["name"];
  if (name === undefined || name.length === 0) {
    return undefined;
  }

  const parsed = AgentIdentityCardSchema.safeParse({
    name,
    principles: listFields["principles"] ?? [],
    taboos: listFields["taboos"] ?? [],
    body: body.trim()
  });

  return parsed.success ? parsed.data : undefined;
}

/**
 * Fast check: does this text contain an identity card (type: identity in
 * frontmatter)? No full validation — just confirms the marker is present.
 */
export function isIdentityCard(text: string): boolean {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return false;
  }
  const closingIdx = normalized.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
  if (closingIdx < 0) {
    return false;
  }
  const headerText = normalized.slice(FRONTMATTER_FENCE.length + 1, closingIdx);
  // Match `type: identity` as a frontmatter key-value pair.
  return /^type:\s*identity\s*$/mu.test(headerText);
}
