/**
 * conversationExport.ts
 * Owned by IDEA-F126-CONV-EXPORT-01
 * Minimal export for conversation transcript to stable JSON.
 */

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface Conversation {
  id?: string;
  messages: ConversationMessage[];
  model?: string;
  agentRole?: string;
  createdAt?: string;
}

export interface ExportedConversation {
  schemaVersion: '1.0';
  id?: string;
  model?: string;
  agentRole?: string;
  createdAt?: string;
  messages: ConversationMessage[];
  exportedAt: string;
}

export function exportConversation(conv: Conversation): ExportedConversation {
  if (!conv || !Array.isArray(conv.messages)) {
    throw new Error('Invalid conversation: missing messages array');
  }
  return {
    schemaVersion: '1.0',
    id: conv.id,
    model: conv.model,
    agentRole: conv.agentRole,
    createdAt: conv.createdAt,
    messages: conv.messages.map(m => ({ ...m })), // shallow copy for stability
    exportedAt: new Date().toISOString(),
  };
}

export function roundTripExport(conv: Conversation): ExportedConversation {
  const exported = exportConversation(conv);
  const json = JSON.stringify(exported);
  return JSON.parse(json) as ExportedConversation;
}
