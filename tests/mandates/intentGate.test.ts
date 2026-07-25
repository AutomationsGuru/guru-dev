import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntentGate } from '../../src/mandates/intentGate.js';

describe('IntentGate', () => {
  let gate: IntentGate;

  beforeEach(() => {
    gate = new IntentGate();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies irreversible operations', () => {
    expect(gate.classifyIrreversible('git', {})).toBe(true);
    expect(gate.classifyIrreversible('publish', {})).toBe(true);
    expect(gate.classifyIrreversible('Read', {})).toBe(false);

    expect(gate.classifyIrreversible('Bash', { command: 'ls -la' })).toBe(false);
    expect(gate.classifyIrreversible('Bash', { command: 'rm -rf /' })).toBe(true);
  });

  it('creates and retrieves pending proposals', () => {
    const proposal = gate.createProposal('git', { action: 'push' });
    expect(proposal.id).toBeDefined();
    expect(proposal.status).toBe('pending');

    const retrieved = gate.getProposal(proposal.id);
    expect(retrieved).toEqual(proposal);
  });

  it('expires pending proposals after time elapses', () => {
    const proposal = gate.createProposal('git', { action: 'push' });
    vi.advanceTimersByTime(16 * 60 * 1000); // 16 minutes

    const retrieved = gate.getProposal(proposal.id);
    expect(retrieved?.status).toBe('expired');
  });

  it('allows approval and returns a token', () => {
    const proposal = gate.createProposal('git', { action: 'push' });
    const token = gate.approve(proposal.id);

    expect(token).toBeDefined();
    const retrieved = gate.getProposal(proposal.id);
    expect(retrieved?.status).toBe('approved');
    expect(retrieved?.approvalToken).toBe(token);
  });

  it('allows rejection', () => {
    const proposal = gate.createProposal('git', { action: 'push' });
    gate.reject(proposal.id);

    const retrieved = gate.getProposal(proposal.id);
    expect(retrieved?.status).toBe('rejected');
  });

  it('executes approved proposals with correct token', () => {
    const proposal = gate.createProposal('git', { action: 'push' });
    const token = gate.approve(proposal.id);

    const executed = gate.execute(proposal.id, token, () => 'done');
    expect(executed).toBe('done');

    // Status should be consumed/expired
    const retrieved = gate.getProposal(proposal.id);
    expect(retrieved?.status).toBe('expired');
  });

  it('blocks execution without valid token', () => {
    const proposal = gate.createProposal('git', { action: 'push' });

    expect(() => {
      gate.execute(proposal.id, 'bad-token', () => 'done');
    }).toThrow('Proposal not approved');

    const token = gate.approve(proposal.id);
    expect(() => {
      gate.execute(proposal.id, 'bad-token', () => 'done');
    }).toThrow('Invalid approval token');
  });

  it('prevents multiple executions (approve once)', () => {
    const proposal = gate.createProposal('git', { action: 'push' });
    const token = gate.approve(proposal.id);

    gate.execute(proposal.id, token, () => 'done');

    expect(() => {
      gate.execute(proposal.id, token, () => 'done');
    }).toThrow('Proposal not approved');
  });
});
