import { describe, it, expect } from 'vitest';
import { AgentRgbPersonaCardSchema } from '../../src/agents/agentRgbPersonaCard.js';

describe('AgentRgbPersonaCardSchema', () => {
  it('parses successfully with valid inputs', () => {
    const validCard = {
      role: 'Developer',
      goal: 'Write code',
      backstory: 'Loves coding',
    };
    const result = AgentRgbPersonaCardSchema.safeParse(validCard);
    expect(result.success).toBe(true);
  });

  it('fails when role is empty', () => {
    const invalidCard = {
      role: '',
      goal: 'Write code',
      backstory: 'Loves coding',
    };
    const result = AgentRgbPersonaCardSchema.safeParse(invalidCard);
    expect(result.success).toBe(false);
  });

  it('fails when goal is empty', () => {
    const invalidCard = {
      role: 'Developer',
      goal: '',
      backstory: 'Loves coding',
    };
    const result = AgentRgbPersonaCardSchema.safeParse(invalidCard);
    expect(result.success).toBe(false);
  });

  it('fails when backstory is empty', () => {
    const invalidCard = {
      role: 'Developer',
      goal: 'Write code',
      backstory: '',
    };
    const result = AgentRgbPersonaCardSchema.safeParse(invalidCard);
    expect(result.success).toBe(false);
  });
});
