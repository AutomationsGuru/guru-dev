import type { ApiSessionTimelineEvent } from "./api.js";

export interface ApiEventStreamRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly event: ApiSessionTimelineEvent;
}

export interface ApiEventStreamSink {
  /** Return false when the accepted frame filled the transport buffer. */
  write(frame: string): boolean;
  /** Register one persistent transport-drain listener and return its cleanup. */
  onDrain(listener: () => void): () => void;
  close(): void;
}

export interface ApiEventStreamScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ApiEventStreamHubOptions {
  readonly replayLimit?: number;
  readonly maxPendingFrames?: number;
  readonly maxPendingBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => number;
  readonly scheduler?: ApiEventStreamScheduler;
}

export interface ApiEventStreamSubscribeOptions {
  readonly sink: ApiEventStreamSink;
  readonly sessionId?: string;
  readonly lastEventId?: string;
}

export interface ApiEventStreamSubscription {
  readonly closed: boolean;
  /** Detach an already-closing client without writing to its transport. */
  unsubscribe(): void;
  /** Detach and close the client transport. */
  close(): void;
}

export interface ApiEventStreamHub {
  readonly subscriberCount: number;
  publish(event: ApiSessionTimelineEvent): ApiEventStreamRecord;
  subscribe(options: ApiEventStreamSubscribeOptions): ApiEventStreamSubscription;
  close(): void;
}

interface RetainedApiEventStreamRecord extends ApiEventStreamRecord {
  readonly numericId: bigint;
}

const DEFAULT_REPLAY_LIMIT = 256;
const DEFAULT_MAX_PENDING_FRAMES = 32;
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

const defaultScheduler: ApiEventStreamScheduler = {
  setInterval(callback, intervalMs) {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  }
};

export function createApiEventStreamHub(options: ApiEventStreamHubOptions = {}): ApiEventStreamHub {
  const replayLimit = positiveInteger(options.replayLimit, DEFAULT_REPLAY_LIMIT, "replayLimit");
  const maxPendingFrames = positiveInteger(options.maxPendingFrames, DEFAULT_MAX_PENDING_FRAMES, "maxPendingFrames");
  const maxPendingBytes = positiveInteger(options.maxPendingBytes, DEFAULT_MAX_PENDING_BYTES, "maxPendingBytes");
  const heartbeatIntervalMs = nonNegativeInteger(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS, "heartbeatIntervalMs");
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? defaultScheduler;
  const retained: RetainedApiEventStreamRecord[] = [];
  const subscribers = new Set<ApiEventStreamSubscriber>();
  let latestId = 0n;
  let droppedThroughId = 0n;
  let closed = false;

  return {
    get subscriberCount() {
      return subscribers.size;
    },
    publish(event) {
      if (closed) {
        throw new Error("API event stream hub is closed.");
      }

      latestId += 1n;
      const record: RetainedApiEventStreamRecord = {
        id: latestId.toString(10),
        numericId: latestId,
        sessionId: event.sessionId,
        event
      };
      retained.push(record);

      while (retained.length > replayLimit) {
        const removed = retained.shift();
        if (removed) {
          droppedThroughId = removed.numericId;
        }
      }

      const frame = encodeEventFrame("session.event", { sessionId: record.sessionId, event: record.event }, record.id);
      for (const subscriber of [...subscribers]) {
        if (subscriber.matches(record.sessionId)) {
          subscriber.send(frame);
        }
      }

      return record;
    },
    subscribe(subscribeOptions) {
      if (closed) {
        throw new Error("API event stream hub is closed.");
      }

      const subscriber = new ApiEventStreamSubscriber({
        sink: subscribeOptions.sink,
        ...(subscribeOptions.sessionId !== undefined ? { sessionId: subscribeOptions.sessionId } : {}),
        maxPendingFrames,
        maxPendingBytes,
        heartbeatIntervalMs,
        now,
        scheduler,
        onRemove: (removedSubscriber) => subscribers.delete(removedSubscriber)
      });
      subscribers.add(subscriber);

      const oldestRetainedId = retained[0]?.id ?? null;
      const latestRetainedId = retained.at(-1)?.id ?? null;
      subscriber.send(encodeEventFrame("ready", { oldestId: oldestRetainedId, latestId: latestRetainedId }));

      const cursor = parseLastEventId(subscribeOptions.lastEventId);
      const cursorPredatesWindow = cursor !== undefined && droppedThroughId > 0n && cursor <= droppedThroughId;
      if (cursorPredatesWindow) {
        subscriber.send(encodeEventFrame("reset", { oldestId: oldestRetainedId, latestId: latestRetainedId }));
      }

      for (const record of retained) {
        if (!subscriber.matches(record.sessionId)) {
          continue;
        }
        if (!cursorPredatesWindow && cursor !== undefined && record.numericId <= cursor) {
          continue;
        }

        subscriber.send(encodeEventFrame("session.event", { sessionId: record.sessionId, event: record.event }, record.id));
      }

      return subscriber;
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      for (const subscriber of [...subscribers]) {
        subscriber.close();
      }
    }
  };
}

interface ApiEventStreamSubscriberOptions {
  readonly sink: ApiEventStreamSink;
  readonly sessionId?: string;
  readonly maxPendingFrames: number;
  readonly maxPendingBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly now: () => number;
  readonly scheduler: ApiEventStreamScheduler;
  readonly onRemove: (subscriber: ApiEventStreamSubscriber) => void;
}

class ApiEventStreamSubscriber implements ApiEventStreamSubscription {
  private readonly pendingFrames: string[] = [];
  private readonly removeDrainListener: () => void;
  private readonly timerHandle: unknown;
  private blocked = false;
  private detached = false;
  private pendingBytes = 0;

  constructor(private readonly options: ApiEventStreamSubscriberOptions) {
    this.removeDrainListener = options.sink.onDrain(() => this.flush());
    this.timerHandle =
      options.heartbeatIntervalMs > 0
        ? options.scheduler.setInterval(() => this.send(`: heartbeat ${Math.trunc(options.now())}\n\n`), options.heartbeatIntervalMs)
        : undefined;
  }

  get closed(): boolean {
    return this.detached;
  }

  matches(sessionId: string): boolean {
    return this.options.sessionId === undefined || this.options.sessionId === sessionId;
  }

  send(frame: string): void {
    if (this.detached) {
      return;
    }

    if (this.blocked) {
      const frameBytes = Buffer.byteLength(frame, "utf8");
      if (this.pendingFrames.length >= this.options.maxPendingFrames || frameBytes > this.options.maxPendingBytes - this.pendingBytes) {
        this.close();
        return;
      }

      this.pendingFrames.push(frame);
      this.pendingBytes += frameBytes;
      return;
    }

    this.write(frame);
  }

  unsubscribe(): void {
    this.detach(false);
  }

  close(): void {
    this.detach(true);
  }

  private flush(): void {
    if (this.detached || !this.blocked) {
      return;
    }

    this.blocked = false;
    while (!this.blocked && this.pendingFrames.length > 0) {
      const frame = this.pendingFrames.shift();
      if (frame !== undefined) {
        this.pendingBytes -= Buffer.byteLength(frame, "utf8");
        this.write(frame);
      }
    }
  }

  private write(frame: string): void {
    try {
      if (!this.options.sink.write(frame)) {
        this.blocked = true;
      }
    } catch {
      this.close();
    }
  }

  private detach(closeTransport: boolean): void {
    if (this.detached) {
      return;
    }

    this.detached = true;
    this.pendingFrames.length = 0;
    this.pendingBytes = 0;
    this.removeDrainListener();
    if (this.timerHandle !== undefined) {
      this.options.scheduler.clearInterval(this.timerHandle);
    }
    this.options.onRemove(this);

    if (closeTransport) {
      try {
        this.options.sink.close();
      } catch {
        // The subscriber is already detached; a failed transport close cannot
        // affect event publication or another subscriber.
      }
    }
  }
}

function encodeEventFrame(eventName: "ready" | "reset" | "session.event", data: unknown, id?: string): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseLastEventId(value: string | undefined): bigint | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined;
  }

  return BigInt(normalized);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }

  return normalized;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }

  return normalized;
}
