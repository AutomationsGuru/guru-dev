/**
 * TranscriptAnchorBookmark — pure bookmark capability by message id.
 *
 * Provides set/get/list/has for anchoring specific message IDs within a
 * transcript without mutating the transcript body itself. This is a focused,
 * standalone pure capability.
 *
 * Design:
 * - Bookmarks are stored by messageId (string).
 * - Missing IDs fail closed (return undefined / false).
 * - list() returns stable sorted order for deterministic behavior.
 * - No side effects on external state; pure in-memory store.
 *
 * This module owns only its own contract and does not edit core runtime.
 */

export interface AnchorBookmark {
  /** The messageId being bookmarked */
  messageId: string;
  /** ISO timestamp when the bookmark was created */
  createdAt: string;
}

/**
 * TranscriptAnchorBookmark manages pure anchor bookmarks by message id.
 */
export class TranscriptAnchorBookmark {
  #bookmarks = new Map<string, AnchorBookmark>();

  /**
   * Set a bookmark for the given messageId.
   * Overwrites if the id already exists (idempotent set).
   *
   * @param messageId - The transcript message id to bookmark
   * @returns The created/updated AnchorBookmark
   * @throws Error if messageId is invalid
   */
  set(messageId: string): AnchorBookmark {
    if (!messageId || typeof messageId !== 'string' || messageId.trim() === '') {
      throw new Error('TranscriptAnchorBookmark.set: messageId must be a non-empty string');
    }
    const bookmark: AnchorBookmark = {
      messageId: messageId.trim(),
      createdAt: new Date().toISOString(),
    };
    this.#bookmarks.set(bookmark.messageId, bookmark);
    return bookmark;
  }

  /**
   * Resolve/get the bookmark for a messageId.
   * Returns undefined for missing id (fails closed — safe default).
   *
   * @param messageId - The message id to look up
   * @returns The AnchorBookmark or undefined if not present or invalid input
   */
  get(messageId: string): AnchorBookmark | undefined {
    if (!messageId || typeof messageId !== 'string') {
      return undefined; // fails closed
    }
    return this.#bookmarks.get(messageId.trim());
  }

  /**
   * Check presence of a bookmark for messageId.
   * Returns false for missing/invalid (fails closed).
   *
   * @param messageId - The message id to check
   * @returns true if bookmarked, false otherwise
   */
  has(messageId: string): boolean {
    if (!messageId || typeof messageId !== 'string') {
      return false; // fails closed
    }
    return this.#bookmarks.has(messageId.trim());
  }

  /**
   * List all currently bookmarked messageIds in stable sorted order.
   * Sorting ensures deterministic output regardless of insertion order.
   *
   * @returns Sorted array of bookmarked messageIds
   */
  list(): string[] {
    return Array.from(this.#bookmarks.keys()).sort();
  }

  /**
   * Remove a specific bookmark.
   * No-op for missing id (fails closed / idempotent).
   *
   * @param messageId - The message id whose bookmark should be removed
   */
  remove(messageId: string): void {
    if (!messageId || typeof messageId !== 'string') {
      return; // fails closed
    }
    this.#bookmarks.delete(messageId.trim());
  }

  /**
   * Clear all bookmarks. Primarily for test isolation.
   */
  clear(): void {
    this.#bookmarks.clear();
  }

  /**
   * Return the count of active bookmarks.
   */
  size(): number {
    return this.#bookmarks.size;
  }
}
