/**
 * Deferred work queue — enqueue items with a reason, dequeue in FIFO order,
 * peek without removal.
 *
 * Used by AgentSession and other session machinery to park work that must be
 * deferred (e.g. while a turn is in-flight or a lock is held) and process it
 * when the session is ready.
 */

export interface DeferredWorkItem<T = unknown> {
  readonly reason: string;
  readonly payload: T;
}

export class DeferredWorkQueue<T = unknown> {
  private readonly items: DeferredWorkItem<T>[] = [];

  /** Append an item to the queue. */
  enqueue(reason: string, payload: T): void {
    this.items.push({ reason, payload });
  }

  /** Remove and return the oldest item, or `undefined` when empty. */
  dequeue(): DeferredWorkItem<T> | undefined {
    return this.items.shift();
  }

  /** Return the oldest item without removing it, or `undefined` when empty. */
  peek(): DeferredWorkItem<T> | undefined {
    return this.items[0];
  }

  /** Number of items currently queued. */
  get length(): number {
    return this.items.length;
  }

  /** Remove all items. */
  clear(): void {
    this.items.length = 0;
  }
}
