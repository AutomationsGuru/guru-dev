import { IntentProposal } from './intentProposal.js';
import crypto from 'crypto';

export class IntentGate {
  private proposals = new Map<string, IntentProposal>();
  private readonly expiryMs = 15 * 60 * 1000; // 15 mins

  classifyIrreversible(tool: string, args: any): boolean {
    const irreversibleTools = ['git', 'rm', 'delete', 'execute', 'publish'];
    if (irreversibleTools.includes(tool)) {
      return true;
    }

    if (tool === 'Bash') {
      const cmd = typeof args?.command === 'string' ? args.command : '';
      if (cmd.includes('rm ') || cmd.includes('git push') || cmd.includes('kill ') || cmd.includes('npm publish')) {
        return true;
      }
    }
    return false;
  }

  createProposal(tool: string, args: any): IntentProposal {
    const id = crypto.randomUUID();
    const proposal: IntentProposal = {
      id,
      tool,
      args,
      status: 'pending',
      createdAt: Date.now()
    };
    this.proposals.set(id, proposal);
    return proposal;
  }

  getProposal(id: string): IntentProposal | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal) return undefined;

    if (proposal.status === 'pending' && Date.now() - proposal.createdAt > this.expiryMs) {
      proposal.status = 'expired';
    }
    return proposal;
  }

  approve(id: string): string {
    const proposal = this.getProposal(id);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'pending') throw new Error(`Cannot approve proposal in status: ${proposal.status}`);

    proposal.status = 'approved';
    proposal.approvalToken = crypto.randomUUID();
    return proposal.approvalToken;
  }

  reject(id: string): void {
    const proposal = this.getProposal(id);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'pending') throw new Error(`Cannot reject proposal in status: ${proposal.status}`);

    proposal.status = 'rejected';
  }

  execute<T>(id: string, token: string, executeFn: () => T): T {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'approved') throw new Error('Proposal not approved');
    if (proposal.approvalToken !== token) throw new Error('Invalid approval token');

    // Consume token to enforce execute-once semantics
    proposal.status = 'expired';
    return executeFn();
  }
}
