export interface IntentProposal {
  id: string;
  tool: string;
  args: any;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvalToken?: string;
  createdAt: number;
}
