import type { ChatTurnMessage } from "../model/directChat.js";

export interface ConversationWorkspaceConversation {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly ChatTurnMessage[];
}

export interface ConversationWorkspaceSummary {
  readonly id: string;
  readonly title: string;
  readonly messageCount: number;
  readonly active: boolean;
}

export interface CreateConversationWorkspaceInput {
  readonly id: string;
  readonly title: string;
  readonly messages?: readonly ChatTurnMessage[];
}

export interface CloneConversationWorkspaceInput {
  readonly id: string;
  readonly title: string;
  /** Defaults to the active conversation. */
  readonly sourceId?: string;
}

export interface ConversationWorkspace {
  readonly activeId: string | null;
  create(input: CreateConversationWorkspaceInput): ConversationWorkspaceConversation;
  list(): readonly ConversationWorkspaceSummary[];
  get(id: string): ConversationWorkspaceConversation | undefined;
  switch(id: string): ConversationWorkspaceConversation;
  previous(): ConversationWorkspaceConversation;
  clone(input: CloneConversationWorkspaceInput): ConversationWorkspaceConversation;
  rename(id: string, title: string): ConversationWorkspaceConversation;
}

interface StoredConversation {
  id: string;
  title: string;
  messages: ChatTurnMessage[];
}

/**
 * A lightweight conversation registry for surfaces that need multiple independent
 * transcripts without coupling to persistence or a specific interactive UI.
 */
export function createConversationWorkspace(): ConversationWorkspace {
  const conversations = new Map<string, StoredConversation>();
  let currentId: string | null = null;
  let previousId: string | null = null;

  const requireId = (id: string): StoredConversation => {
    const conversation = conversations.get(normalizeId(id));
    if (!conversation) {
      throw new Error(`Conversation workspace: unknown conversation "${id}".`);
    }
    return conversation;
  };

  const snapshot = (conversation: StoredConversation): ConversationWorkspaceConversation => ({
    id: conversation.id,
    title: conversation.title,
    messages: copyMessages(conversation.messages)
  });

  const workspace: ConversationWorkspace = {
    get activeId() {
      return currentId;
    },
    create(input) {
      const id = normalizeId(input.id);
      if (conversations.has(id)) {
        throw new Error(`Conversation workspace: conversation "${id}" already exists.`);
      }
      const conversation = {
        id,
        title: normalizeTitle(input.title),
        messages: copyMessages(input.messages ?? [])
      };
      conversations.set(id, conversation);
      if (currentId === null) {
        currentId = id;
      }
      return snapshot(conversation);
    },
    list() {
      return [...conversations.values()].map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        messageCount: conversation.messages.length,
        active: conversation.id === currentId
      }));
    },
    get(id) {
      const conversation = conversations.get(normalizeId(id));
      return conversation ? snapshot(conversation) : undefined;
    },
    switch(id) {
      const conversation = requireId(id);
      if (conversation.id !== currentId) {
        previousId = currentId;
        currentId = conversation.id;
      }
      return snapshot(conversation);
    },
    previous() {
      if (previousId === null) {
        throw new Error("Conversation workspace: no previous conversation.");
      }
      return workspace.switch(previousId);
    },
    clone(input) {
      const id = normalizeId(input.id);
      if (conversations.has(id)) {
        throw new Error(`Conversation workspace: conversation "${id}" already exists.`);
      }
      const source = requireId(input.sourceId ?? currentId ?? "");
      const clone = {
        id,
        title: normalizeTitle(input.title),
        messages: copyMessages(source.messages)
      };
      conversations.set(id, clone);
      previousId = currentId;
      currentId = id;
      return snapshot(clone);
    },
    rename(id, title) {
      const conversation = requireId(id);
      conversation.title = normalizeTitle(title);
      return snapshot(conversation);
    }
  };

  return workspace;
}

function normalizeId(value: string): string {
  const id = value.trim();
  if (id.length === 0) {
    throw new Error("Conversation workspace: conversation id is required.");
  }
  return id;
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) {
    throw new Error("Conversation workspace: conversation title is required.");
  }
  return title;
}

function copyMessages(messages: readonly ChatTurnMessage[]): ChatTurnMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}
