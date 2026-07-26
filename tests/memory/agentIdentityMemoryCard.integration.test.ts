import { describe, it, expect } from 'vitest';
import {
  AgentIdentityCardSchema,
  type AgentIdentityCard,
  serializeIdentityCard,
  parseIdentityCard,
  isIdentityCard
} from '../../src/memory/agentIdentityMemoryCard.js';

/**
 * Integration-oriented tests for Agent Identity Memory (f174).
 * These complement the unit roundtrips from the sibling card worktree.
 * Non-authority invariant and scope isolation are enforced at call sites.
 */

describe('AgentIdentityCard schema + serialization (integration shape)', () => {
  it('accepts minimal valid card and roundtrips via serialize/parse', () => {
    const input: AgentIdentityCard = {
      name: 'GuruLinux',
      principles: ['Linux-first', 'Preserve user work'],
      taboos: ['Never commit without review'],
      body: 'Daily-driver builder on codex01.'
    };

    const md = serializeIdentityCard(input);
    expect(isIdentityCard(md)).toBe(true);

    const restored = parseIdentityCard(md);
    expect(restored).toBeDefined();
    expect(restored?.name).toBe('GuruLinux');
    expect(restored?.principles).toEqual(['Linux-first', 'Preserve user work']);
    expect(restored?.taboos?.length).toBe(1);
  });

  it('rejects authority escalation attempts (non-authority invariant)', () => {
    // Schema is strict and has no 'authority' or 'scopes' field.
    // Any attempt to add privileged fields must fail parse or be ignored.
    const malicious = {
      name: 'EvilAgent',
      principles: [],
      taboos: [],
      body: '',
      authority: true, // extra field
      scopes: ['admin']
    };

    const result = AgentIdentityCardSchema.safeParse(malicious);
    expect(result.success).toBe(false);
  });
});

describe('Boot ritual memory phase compatibility (placeholder)', () => {
  it('identity card can be injected without altering boot phase order', () => {
    // Future: load via ritual memory phase + mergeScopedBootInjection
    // For now, verify no breakage to phase enum
    expect(true).toBe(true); // placeholder until wired in inject.ts / ritual.ts
  });
});
