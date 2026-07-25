/**
 * Transcript anchor bookmark — a pure bookmark of a transcript position keyed by
 * message id. Bookmarks are stored by name → messageId and resolve against a
 * transcript array the caller supplies. Resolution performs a read-only lookup;
 * the transcript body is never mutated, rewritten, or reordered.
 *
 * Scope (per IDEA-F595-TBOOK-01): a small, owned, in-memory capability — no
 * persistence, no transcript-shape coupling beyond `{ id: string }`, and no
 * dependency on core session state. The transcript type is intentionally generic
 * so this can later be wired into the conversation/session layer without editing
 * core.
 */

/** Minimum shape a transcript message needs to be anchorable: a stable id. */
export interface AnchorableMessage {
  readonly id: string;
}

/** A named bookmark pointing at a single transcript message id. */
export interface TranscriptAnchorBookmark {
  readonly name: string;
  readonly messageId: string;
}

/** A resolved bookmark: the name, the id, and the matching transcript message. */
export interface ResolvedTranscriptAnchorBookmark<M extends AnchorableMessage> {
  readonly name: string;
  readonly messageId: string;
  readonly message: M;
}

export interface TranscriptAnchorBookmarks<M extends AnchorableMessage = AnchorableMessage> {
  /** Set (or overwrite) a named bookmark. Names are trimmed; empty/whitespace names fail closed. */
  set(name: string, messageId: string): void;
  /** Get the message id stored under a (trimmed) bookmark name, or `undefined` if absent. */
  get(name: string): string | undefined;
  /** Remove a bookmark. Returns `true` if a bookmark was removed, `false` otherwise. */
  delete(name: string): boolean;
  /** List bookmarks in stable insertion order (overwrite preserves original position). */
  list(): readonly TranscriptAnchorBookmark[];
  /**
   * Resolve a bookmark to its matching transcript message. Fails closed — returns
   * `undefined` if the bookmark is missing, its message id is absent from the
   * transcript, or the transcript is empty. Never mutates the transcript.
   */
  resolve(name: string, transcript: readonly M[]): M | undefined;
  /** Resolve every bookmark in stable order, skipping any whose message id is absent. */
  resolveAll(transcript: readonly M[]): readonly ResolvedTranscriptAnchorBookmark<M>[];
}

interface BookmarkEntry {
  readonly messageId: string;
  /** Monotonic insertion order; preserved across overwrites of an existing name. */
  readonly order: number;
}

function normalizeName(name: string): string {
  if (typeof name !== "string") {
    throw new Error("Bookmark name must be a string.");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Bookmark name must not be empty or whitespace-only.");
  }
  return trimmed;
}

/**
 * Create a fresh, empty bookmark registry. Pure and in-memory — no I/O, no shared
 * mutable state, no persistence. Each call yields an independent instance.
 */
export function createTranscriptAnchorBookmarks<M extends AnchorableMessage = AnchorableMessage>(): TranscriptAnchorBookmarks<M> {
  const entries = new Map<string, BookmarkEntry>();
  let nextOrder = 0;

  const set = (name: string, messageId: string): void => {
    const normalized = normalizeName(name);
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new Error("Bookmark messageId must be a non-empty string.");
    }
    const existing = entries.get(normalized);
    if (existing) {
      // Overwrite in place: keep the original insertion order so list()/resolveAll()
      // remain stable across re-anchoring.
      entries.set(normalized, { messageId, order: existing.order });
    } else {
      entries.set(normalized, { messageId, order: nextOrder });
      nextOrder += 1;
    }
  };

  const get = (name: string): string | undefined => {
    const normalized = normalizeName(name);
    return entries.get(normalized)?.messageId;
  };

  const delete_ = (name: string): boolean => {
    const normalized = normalizeName(name);
    return entries.delete(normalized);
  };

  const list = (): readonly TranscriptAnchorBookmark[] => {
    return [...entries.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([name, entry]) => ({ name, messageId: entry.messageId }));
  };

  const resolve = (name: string, transcript: readonly M[]): M | undefined => {
    const normalized = normalizeName(name);
    const entry = entries.get(normalized);
    if (!entry) return undefined;
    for (const message of transcript) {
      if (message && message.id === entry.messageId) return message;
    }
    return undefined;
  };

  const resolveAll = (transcript: readonly M[]): readonly ResolvedTranscriptAnchorBookmark<M>[] => {
    const byId = new Map<string, M>();
    for (const message of transcript) {
      if (message && typeof message.id === "string" && !byId.has(message.id)) {
        byId.set(message.id, message);
      }
    }
    const out: ResolvedTranscriptAnchorBookmark<M>[] = [];
    for (const { name, messageId } of list()) {
      const message = byId.get(messageId);
      if (message) out.push({ name, messageId, message });
    }
    return out;
  };

  return { set, get, delete: delete_, list, resolve, resolveAll };
}
