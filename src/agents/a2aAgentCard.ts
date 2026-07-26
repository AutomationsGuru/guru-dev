import { z } from "zod";

/**
 * A2A agent card — a pure, self-describing {id, name, capabilities[]} descriptor.
 *
 * This module is parse/serialize only. It owns no network, discovery, protocol,
 * provider authority, or external dependency: it turns a structured agent card
 * into a stable JSON string and back. An A2A mesh (if ever introduced) is an
 * opt-in ATTACH at the interop layer (F271), never a hidden foundation here.
 */

/** Capability identifier — non-empty trimmed string. */
export const A2ACapabilitySchema = z.string().trim().min(1);

/**
 * The structured A2A agent card.
 *
 * `strict()` makes the roundtrip well-defined: unknown keys are rejected on
 * parse, so serialize → parse is an identity for any card that round-trips.
 */
export const A2AAgentCardSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    capabilities: z.array(A2ACapabilitySchema).default([])
  })
  .strict();
export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;
/** Input type — `capabilities` is optional (defaults to `[]`). */
export type A2AAgentCardInput = z.input<typeof A2AAgentCardSchema>;

/** Type guard: true when `value` parses as a valid A2A agent card. */
export function isA2AAgentCard(value: unknown): value is A2AAgentCard {
  return A2AAgentCardSchema.safeParse(value).success;
}

/**
 * Serialize a card to a canonical JSON string. Keys are emitted in declaration
 * order; `capabilities` defaults to `[]` when omitted so output is stable.
 * Throws if the card is invalid (callers that need to handle bad input should
 * use {@link isA2AAgentCard} first, or catch the thrown {@link ZodError}).
 */
export function serializeA2AAgentCard(card: A2AAgentCardInput): string {
  const parsed = A2AAgentCardSchema.parse(card);
  return JSON.stringify(parsed);
}

/**
 * Parse a JSON string (or an already-decoded object) into a validated card.
 * Throws a {@link ZodError} on malformed JSON or schema mismatch.
 */
export function parseA2AAgentCard(input: string | Readonly<Record<string, unknown>>): A2AAgentCard {
  const decoded: unknown = typeof input === "string" ? JSON.parse(input) : input;
  return A2AAgentCardSchema.parse(decoded);
}
