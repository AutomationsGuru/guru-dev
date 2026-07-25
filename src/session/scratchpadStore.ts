/**
 * ScratchpadSessionStore — an in-memory, session-scoped key/value note surface.
 *
 * Notes are stored in process memory only. No disk persistence, no secrets,
 * no cross-session leakage. Each key is scoped to an explicit sessionId.
 */

export type ScratchpadValue = string | number | boolean | object;

export interface ScratchpadEntry {
  readonly value: ScratchpadValue;
  readonly storedAt: Date;
}

export class ScratchpadSessionStore {
  private readonly sessions = new Map<string, Map<string, ScratchpadEntry>>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Store a note under a sessionId. Overwrites any existing value for the key. */
  put(sessionId: string, key: string, value: ScratchpadValue): void {
    if (sessionId.length === 0 || key.length === 0) {
      throw new Error("ScratchpadSessionStore.put: sessionId and key must be non-empty strings.");
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Map<string, ScratchpadEntry>();
      this.sessions.set(sessionId, session);
    }
    session.set(key, { value, storedAt: this.now() });
  }

  /** Retrieve a note by sessionId and key, or undefined if absent. */
  get(sessionId: string, key: string): ScratchpadValue | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.get(key)?.value;
  }

  /**
   * Clear notes for a session. If key is omitted, all notes for that session are
   * removed; if key is provided, only that key is removed. Removing the last key
   * removes the session map as well.
   */
  clear(sessionId: string, key?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (key === undefined) {
      this.sessions.delete(sessionId);
      return;
    }

    session.delete(key);
    if (session.size === 0) {
      this.sessions.delete(sessionId);
    }
  }

  /** Return all keys stored for a session. */
  keys(sessionId: string): readonly string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return [...session.keys()];
  }

  /** Internal introspection: count of distinct sessions currently holding notes. */
  sessionCount(): number {
    return this.sessions.size;
  }
}
