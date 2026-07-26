import { z } from "zod";

/**
 * a2aAgentCard
 *
 * Minimal, owned serialization for an Agent-to-Agent (A2A) agent card:
 * a structured `{ id, name, capabilities[] }` descriptor that can be published to
 * a peer agent and parsed back losslessly.
 *
 * This is a hand-rolled, zod-validated value type — not a third-party A2A SDK.
 * It implements only the surface the harness needs today (identity + capability
 * list) and validates structurally in code rather than relying on prose rules.
 * Capability entries are free-form strings today; the shape can widen behind this
 * same serialize/parse seam without editing core.
 */

/** Schema for a single capability string. Non-empty after trimming. */
export const AgentCardCapabilitySchema = z
  .string()
  .trim()
  .min(1, "capability must be a non-empty string");

/**
 * Schema for an A2A agent card value.
 *
 * - `id`: stable agent identifier (non-empty, trimmed).
 * - `name`: human-readable agent name (non-empty, trimmed).
 * - `capabilities`: ordered list of capability strings (may be empty; entries
 *   must be non-empty; duplicates are preserved as-authored).
 */
export const AgentCardSchema = z.object({
  id: z.string().trim().min(1, "id must be a non-empty string"),
  name: z.string().trim().min(1, "name must be a non-empty string"),
  capabilities: z.array(AgentCardCapabilitySchema).default([]),
});

/** A validated A2A agent card value. Capabilities default to `[]` when absent. */
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** A raw (pre-validation) agent card shape accepted by {@link parseAgentCard}. */
export type AgentCardInput = z.input<typeof AgentCardSchema>;

/**
 * Parse an unknown value into a validated {@link AgentCard}.
 *
 * Accepts either a parsed card object or a JSON string (as produced by
 * {@link serializeAgentCard}); strings are `JSON.parse`d first. Throws a zod
 * error for a malformed card, or a `SyntaxError` for a non-JSON string. Empty /
 * absent `capabilities` normalizes to `[]`. Strings are trimmed; empty
 * id/name/capability entries are rejected. Unknown top-level keys are stripped
 * (forward-compatible: peers may include extra A2A fields).
 */
export function parseAgentCard(input: unknown): AgentCard {
  const value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  return AgentCardSchema.parse(value);
}

/**
 * Serialize an {@link AgentCard} (or raw input) to a canonical JSON string.
 *
 * The input is validated through {@link parseAgentCard} first, so the emitted
 * payload is always a well-formed card with normalized fields. Output is stable:
 * keys are emitted in declaration order (`id`, `name`, `capabilities`) and
 * `capabilities` is always present (possibly `[]`).
 */
export function serializeAgentCard(card: AgentCardInput): string {
  const validated = parseAgentCard(card);
  return JSON.stringify({
    id: validated.id,
    name: validated.name,
    capabilities: validated.capabilities,
  });
}

/**
 * Round-trip a card through serialize → parse and return the validated value.
 *
 * Convenience for callers that want a canonicalized card from raw input. The
 * result is deeply equal (modulo normalization) to {@link parseAgentCard} on the
 * same input.
 */
export function canonicalizeAgentCard(card: AgentCardInput): AgentCard {
  return parseAgentCard(serializeAgentCard(card));
}
