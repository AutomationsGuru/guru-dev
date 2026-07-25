import { describe, it, expect } from 'vitest';
import {
  serializeAgentCard,
  parseAgentCard,
  roundtripAgentCard,
  A2AAgentCard,
  A2AAgentCardError,
} from '../../src/agents/a2aAgentCard.js';

describe('A2AAgentCard serialize/parse', () => {
  const validCard: A2AAgentCard = {
    id: 'agent-001',
    name: 'TestAgent',
    capabilities: ['chat', 'tool-call', 'stream'],
  };

  it('serializes a valid agent card', () => {
    const json = serializeAgentCard(validCard);
    expect(json).toContain('"id":"agent-001"');
    expect(json).toContain('"name":"TestAgent"');
    expect(json).toContain('"capabilities":["chat","tool-call","stream"]');
  });

  it('parses a valid JSON agent card', () => {
    const json = JSON.stringify(validCard);
    const parsed = parseAgentCard(json);
    expect(parsed).toEqual(validCard);
  });

  it('roundtrips correctly', () => {
    const result = roundtripAgentCard(validCard);
    expect(result).toEqual(validCard);
  });

  it('throws on missing id', () => {
    const bad = { ...validCard, id: '' };
    expect(() => serializeAgentCard(bad)).toThrow(A2AAgentCardError);
    expect(() => serializeAgentCard(bad)).toThrow(/id must be a non-empty string/);
  });

  it('throws on missing name', () => {
    const bad = { ...validCard, name: '' };
    expect(() => serializeAgentCard(bad)).toThrow(A2AAgentCardError);
    expect(() => serializeAgentCard(bad)).toThrow(/name must be a non-empty string/);
  });

  it('throws on non-array capabilities', () => {
    const bad = { ...validCard, capabilities: 'chat' as any };
    expect(() => serializeAgentCard(bad)).toThrow(A2AAgentCardError);
    expect(() => serializeAgentCard(bad)).toThrow(/capabilities must be an array/);
  });

  it('throws on non-string capability', () => {
    const bad = { ...validCard, capabilities: ['chat', 42 as any] };
    expect(() => serializeAgentCard(bad)).toThrow(A2AAgentCardError);
    expect(() => serializeAgentCard(bad)).toThrow(/All capabilities must be strings/);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAgentCard('{not json}')).toThrow(A2AAgentCardError);
    expect(() => parseAgentCard('{not json}')).toThrow(/Invalid JSON/);
  });

  it('throws on non-object parsed value', () => {
    expect(() => parseAgentCard('42')).toThrow(/must be an object/);
    expect(() => parseAgentCard('"string"')).toThrow(/must be an object/);
    expect(() => parseAgentCard('null')).toThrow(/must be an object/);
  });

  it('throws on missing fields during parse', () => {
    expect(() => parseAgentCard('{"id":"x"}')).toThrow(/name must be a non-empty string/);
    expect(() => parseAgentCard('{"name":"x"}')).toThrow(/id must be a non-empty string/);
    expect(() => parseAgentCard('{"id":"x","name":"y"}')).toThrow(/capabilities must be an array/);
  });

  it('rejects non-string input to parseAgentCard', () => {
    expect(() => parseAgentCard(123 as any)).toThrow(/Input must be a string/);
  });

  it('rejects non-object input to serializeAgentCard', () => {
    expect(() => serializeAgentCard(null as any)).toThrow(/must be an object/);
    expect(() => serializeAgentCard('not an object' as any)).toThrow(/must be an object/);
  });
});
