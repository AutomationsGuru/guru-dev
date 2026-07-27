/**
 * ConversationWorkspace — in-memory registry for conversation workspaces.
 * Supports: create, list, switch, previous toggle, clone, rename.
 * VISION: lightweight, independent, state-preserving workspace management.
 */

export interface Workspace {
  id: string;
  title: string;
  messages: any[]; // opaque message array; deep-cloned on clone
  createdAt: number;
  lastActive: number;
}

export class ConversationWorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private currentWorkspaceId: string | null = null;
  private previousWorkspaceId: string | null = null;

  create(id: string, title: string): Workspace {
    if (this.workspaces.has(id)) {
      throw new Error(`Workspace ${id} already exists`);
    }
    const now = Date.now();
    const ws: Workspace = {
      id,
      title,
      messages: [],
      createdAt: now,
      lastActive: now,
    };
    this.workspaces.set(id, ws);
    return ws;
  }

  list(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  switchWorkspace(id: string): Workspace {
    if (!this.workspaces.has(id)) {
      throw new Error(`Workspace ${id} not found`);
    }
    // Track previous for toggle
    if (this.currentWorkspaceId && this.currentWorkspaceId !== id) {
      this.previousWorkspaceId = this.currentWorkspaceId;
    }
    this.currentWorkspaceId = id;
    // Update lastActive to track most recent switch (VISION: preserve activity state)
    this.workspaces.get(id)!.lastActive = Date.now();
    return this.workspaces.get(id)!;
  }

  getCurrent(): Workspace | null {
    return this.currentWorkspaceId
      ? this.workspaces.get(this.currentWorkspaceId) ?? null
      : null;
  }

  previous(): Workspace | null {
    if (!this.previousWorkspaceId) {
      return null;
    }
    const prevId = this.previousWorkspaceId;
    // Toggle: switch back, update previous to what was current
    const current = this.currentWorkspaceId;
    this.currentWorkspaceId = prevId;
    this.previousWorkspaceId = current;
    const ws = this.workspaces.get(prevId)!;
    ws.lastActive = Date.now();
    return ws;
  }

  clone(sourceId: string, newId: string, newTitle?: string): Workspace {
    const source = this.workspaces.get(sourceId);
    if (!source) {
      throw new Error(`Workspace ${sourceId} not found`);
    }
    if (this.workspaces.has(newId)) {
      throw new Error(`Workspace ${newId} already exists`);
    }
    const now = Date.now();
    const cloned: Workspace = {
      id: newId,
      title: newTitle ?? `${source.title} (clone)`,
      messages: JSON.parse(JSON.stringify(source.messages)), // deep clone
      createdAt: now,
      lastActive: now,
    };
    this.workspaces.set(newId, cloned);
    return cloned;
  }

  rename(id: string, newTitle: string): Workspace {
    const ws = this.workspaces.get(id);
    if (!ws) {
      throw new Error(`Workspace ${id} not found`);
    }
    ws.title = newTitle;
    return ws;
  }

  delete(id: string): void {
    if (!this.workspaces.has(id)) {
      throw new Error(`Workspace ${id} not found`);
    }
    if (this.currentWorkspaceId === id) {
      this.currentWorkspaceId = null;
    }
    if (this.previousWorkspaceId === id) {
      this.previousWorkspaceId = null;
    }
    this.workspaces.delete(id);
  }

  // For testing / inspection only
  _resetForTests(): void {
    this.workspaces.clear();
    this.currentWorkspaceId = null;
    this.previousWorkspaceId = null;
  }
}
