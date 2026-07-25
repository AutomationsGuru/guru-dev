/**
 * Steer vs follow-up semantics for the AgentSession engine and its adapters.
 *
 * `steer` interrupts/redirects active work: it is injected at the next turn boundary
 * or pulled mid-run. `followUp` queues after the current step and is executed as a
 * fresh turn once the agent stops. The queue is bounded, FIFO per kind, and
 * optionally configurable so that a new steer can clear stale follow-ups when the
 * operator is explicitly changing direction.
 *
 * This module exports the raw queue so TUI/RPC adapters can apply the same
 * semantics without coupling to the full AgentSession.
 */

export interface SteerRequest {
  readonly kind: "steer";
  readonly text: string;
  readonly at: number;
}

export interface FollowUpRequest {
  readonly kind: "follow_up";
  readonly text: string;
  readonly at: number;
}

export type QueuedSteer = SteerRequest | FollowUpRequest;

export interface SteerFollowUpQueueOptions {
  /**
   * Global maximum queued items. Once the limit is reached, the oldest queued item
   * of the same kind as the incoming item is dropped to make room. Defaults to 32.
   */
  readonly maxDepth?: number;
  /**
   * Maximum queued follow-up items. When exceeded, the oldest follow-up is dropped.
   * Cannot exceed `maxDepth`. Defaults to `maxDepth`.
   */
  readonly maxFollowUpDepth?: number;
  /**
   * When true, enqueueing a steer drops all pending follow-ups. The operator's
   * explicit direction change takes precedence over queued continuation items.
   * Defaults to false (follow-ups survive steers, matching the historical FIFO).
   */
  readonly steerClearsFollowUps?: boolean;
  /** Called whenever a steer is removed from the queue for injection. */
  readonly onSteerInjected?: (request: SteerRequest) => void;
  /** Called whenever a follow-up is removed from the queue to become a turn. */
  readonly onFollowUpTaken?: (request: FollowUpRequest) => void;
  /** Called when an item is dropped because of a bound or a steer-clear policy. */
  readonly onDropped?: (request: QueuedSteer, reason: "max-depth" | "steer-cleared") => void;
  /** Clock source; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface SteerFollowUpQueue {
  /** Enqueue a steer (interruption/redirect). */
  steer(text: string): void;
  /** Enqueue a follow-up to run after the current step. */
  followUp(text: string): void;
  /** Total queued items (steers + follow-ups). */
  queueDepth(): number;
  /** Count of queued steers. */
  pendingSteerCount(): number;
  /** Count of queued follow-ups. */
  pendingFollowUpCount(): number;
  /** Remove and return all queued steers in FIFO order. */
  takeSteers(): readonly SteerRequest[];
  /** Remove and return all queued follow-ups in FIFO order. */
  takeFollowUps(): readonly FollowUpRequest[];
  /** Remove and return steers queued DURING a running turn (mid-run injection). */
  drainMidRunSteers(): readonly SteerRequest[];
  /** Drop all pending steers, keeping follow-ups. Returns the dropped steer texts. */
  discardPendingSteers(): readonly string[];
  /** Immutable snapshot of the current queue, oldest-first. */
  snapshot(): readonly QueuedSteer[];
  /** Format a steer for injection as a system message. */
  formatSteerMessage(request: SteerRequest): string;
  /** Format a follow-up for submission as a user turn. */
  formatFollowUpMessage(request: FollowUpRequest): string;
}

const DEFAULT_MAX_DEPTH = 32;

function normalize(text: string): string {
  return text.trim();
}

export function createSteerFollowUpQueue(options: SteerFollowUpQueueOptions = {}): SteerFollowUpQueue {
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxFollowUpDepth = Math.max(1, Math.min(options.maxFollowUpDepth ?? maxDepth, maxDepth));
  const steerClearsFollowUps = options.steerClearsFollowUps ?? false;
  const onSteerInjected = options.onSteerInjected;
  const onFollowUpTaken = options.onFollowUpTaken;
  const onDropped = options.onDropped;
  const now = options.now ?? Date.now;

  const items: QueuedSteer[] = [];

  function drop(item: QueuedSteer, reason: "max-depth" | "steer-cleared"): void {
    onDropped?.(item, reason);
  }

  function trim(kind: "steer" | "follow_up"): void {
    const limit = kind === "follow_up" ? maxFollowUpDepth : maxDepth;
    let count = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i] as QueuedSteer;
      if (item.kind === kind) {
        count += 1;
        if (count > limit) {
          drop(item, "max-depth");
          items.splice(i, 1);
        }
      }
    }
  }

  function enqueue(item: QueuedSteer): void {
    items.push(item);
    trim(item.kind);
  }

  return {
    steer(text: string): void {
      const normalized = normalize(text);
      if (normalized.length === 0) return;

      if (steerClearsFollowUps) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i] as QueuedSteer;
          if (item.kind === "follow_up") {
            drop(item, "steer-cleared");
            items.splice(i, 1);
          }
        }
      }

      enqueue({ kind: "steer", text: normalized, at: now() });
    },

    followUp(text: string): void {
      const normalized = normalize(text);
      if (normalized.length === 0) return;
      enqueue({ kind: "follow_up", text: normalized, at: now() });
    },

    queueDepth(): number {
      return items.length;
    },

    pendingSteerCount(): number {
      let count = 0;
      for (const item of items) {
        if (item.kind === "steer") count += 1;
      }
      return count;
    },

    pendingFollowUpCount(): number {
      let count = 0;
      for (const item of items) {
        if (item.kind === "follow_up") count += 1;
      }
      return count;
    },

    takeSteers(): readonly SteerRequest[] {
      const out: SteerRequest[] = [];
      for (let i = 0; i < items.length; ) {
        const item = items[i] as QueuedSteer;
        if (item.kind === "steer") {
          out.push(item);
          onSteerInjected?.(item);
          items.splice(i, 1);
        } else {
          i += 1;
        }
      }
      return out;
    },

    takeFollowUps(): readonly FollowUpRequest[] {
      const out: FollowUpRequest[] = [];
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i] as QueuedSteer;
        if (item.kind === "follow_up") {
          out.unshift(item);
          items.splice(i, 1);
        }
      }
      for (const request of out) {
        onFollowUpTaken?.(request);
      }
      return out;
    },

    drainMidRunSteers(): readonly SteerRequest[] {
      // Semantically identical to takeSteers: mid-run injection is still a steer
      // removal, but adapters may call the named variant to document intent.
      return this.takeSteers();
    },

    discardPendingSteers(): readonly string[] {
      const dropped: string[] = [];
      for (let i = 0; i < items.length; ) {
        const item = items[i] as QueuedSteer;
        if (item.kind === "steer") {
          dropped.push(item.text);
          items.splice(i, 1);
        } else {
          i += 1;
        }
      }
      return dropped;
    },

    snapshot(): readonly QueuedSteer[] {
      return items.slice();
    },

    formatSteerMessage(request: SteerRequest): string {
      return `[steering] ${request.text}`;
    },

    formatFollowUpMessage(request: FollowUpRequest): string {
      return request.text;
    }
  };
}

/** Type guard: returns true when the queued item is a steer. */
export function isSteerRequest(item: QueuedSteer): item is SteerRequest {
  return item.kind === "steer";
}

/** Type guard: returns true when the queued item is a follow-up. */
export function isFollowUpRequest(item: QueuedSteer): item is FollowUpRequest {
  return item.kind === "follow_up";
}
