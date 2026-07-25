/**
 * A2A Agent Card
 *
 * Structured agent card with {id, name, capabilities[]} for A2A protocol.
 * Provides serialize/parse with validation.
 */

export interface A2AAgentCard {
  id: string;
  name: string;
  capabilities: string[];
}

export class A2AAgentCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2AAgentCardError';
  }
}

/**
 * Serializes an A2AAgentCard to a JSON string.
 */
export function serializeAgentCard(card: A2AAgentCard): string {
  if (!card || typeof card !== 'object') {
    throw new A2AAgentCardError('Agent card must be an object');
  }
  if (typeof card.id !== 'string' || card.id.length === 0) {
    throw new A2AAgentCardError('Agent card id must be a non-empty string');
  }
  if (typeof card.name !== 'string' || card.name.length === 0) {
    throw new A2AAgentCardError('Agent card name must be a non-empty string');
  }
  if (!Array.isArray(card.capabilities)) {
    throw new A2AAgentCardError('Agent card capabilities must be an array');
  }
  if (!card.capabilities.every((c: unknown) => typeof c === 'string')) {
    throw new A2AAgentCardError('All capabilities must be strings');
  }
  return JSON.stringify(card);
}

/**
 * Parses a JSON string into an A2AAgentCard.
 * Throws A2AAgentCardError on invalid input.
 */
export function parseAgentCard(json: string): A2AAgentCard {
  if (typeof json !== 'string') {
    throw new A2AAgentCardError('Input must be a string');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new A2AAgentCardError('Invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new A2AAgentCardError('Parsed value must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    throw new A2AAgentCardError('Agent card id must be a non-empty string');
  }
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new A2AAgentCardError('Agent card name must be a non-empty string');
  }
  if (!Array.isArray(obj.capabilities)) {
    throw new A2AAgentCardError('Agent card capabilities must be an array');
  }
  if (!obj.capabilities.every((c: unknown) => typeof c === 'string')) {
    throw new A2AAgentCardError('All capabilities must be strings');
  }
  return {
    id: obj.id,
    name: obj.name,
    capabilities: obj.capabilities as string[],
  };
}

/**
 * Roundtrip helper: serialize then parse.
 */
export function roundtripAgentCard(card: A2AAgentCard): A2AAgentCard {
  return parseAgentCard(serializeAgentCard(card));
}
