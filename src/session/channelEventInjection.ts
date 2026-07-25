/**
 * Channel event injection — enqueue external steer events into a thread inbox
 * with type+payload validation.
 *
 * Maps to Zagens K13 (channel event injection → external steer), an ENHANCE
 * on the F59 RPC residual. Kept purposefully small: a typed FIFO inbox with
 * known-type gating and no runtime dependencies beyond the stdlib.
 */

/** A validated external steer event enqueued into a thread inbox. */
export interface ChannelEvent {
  readonly type: string;
  readonly payload: unknown;
  /** ISO-8601 timestamp set at injection time. */
  readonly at: string;
}

/** A typed FIFO inbox for channel events. */
export interface ChannelEventInbox {
  /**
   * Enqueue an event. Throws if `type` is not in the known set — unknown
   * types are rejected fail-closed so callers cannot silently inject
   * ungoverned events.
   */
  inject(type: string, payload: unknown): void;
  /** Return a snapshot of all pending events (oldest first). */
  listPending(): readonly ChannelEvent[];
  /** Dequeue and return the oldest event, or `undefined` if empty. */
  pop(): ChannelEvent | undefined;
}

export function createChannelEventInbox(knownTypes: ReadonlySet<string>): ChannelEventInbox {
  const queue: ChannelEvent[] = [];

  const inject = (type: string, payload: unknown): void => {
    if (!knownTypes.has(type)) {
      throw new Error(
        `Unknown channel event type: "${type}". Known types: ${[...knownTypes].sort().join(", ") || "(none)"}.`
      );
    }
    queue.push({ type, payload, at: new Date().toISOString() });
  };

  const listPending = (): readonly ChannelEvent[] => [...queue];

  const pop = (): ChannelEvent | undefined => queue.shift();

  return { inject, listPending, pop };
}
