import { scrubSecretValues } from "../safety/secretSafety.js";

/**
 * Opt-in session audit SSE channel.
 *
 * The channel is deliberately independent from the API event stream: callers
 * can use it as a small session-local extension seam and later map these
 * metadata-only frames into the bounded API stream. It never exports intent or
 * tool contents, and it is disabled until the owner explicitly enables it.
 */

export type AuditEventType = "intent" | "tool" | "approval";

export interface AuditEvent {
  readonly id: number;
  readonly timestamp: string;
  readonly type: AuditEventType;
  readonly sessionId?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditEventInput {
  readonly type: AuditEventType;
  readonly sessionId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type AuditEventListener = (event: AuditEvent) => void;
export type AuditSseListener = (frame: string) => void;

let enabled = false;
let nextId = 1;
const events: AuditEvent[] = [];
const listeners = new Set<AuditEventListener>();
const sseListeners = new Set<AuditSseListener>();

/** Enable audit publication. Repeated calls are harmless and return false. */
export function enableAuditSse(): boolean {
  if (enabled) {
    return false;
  }
  enabled = true;
  return true;
}

/** Disable publication and detach all live listeners. */
export function disableAuditSse(): void {
  enabled = false;
  listeners.clear();
  sseListeners.clear();
}

export function isAuditSseEnabled(): boolean {
  return enabled;
}

/** Emit one metadata-only event, preserving call order while enabled. */
export function emitAuditEvent(input: AuditEventInput): void {
  if (!enabled) {
    return;
  }

  const metadata = sanitizeMetadata(input.metadata);
  const event: AuditEvent = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    type: input.type,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    metadata
  };
  events.push(event);

  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A consumer cannot interrupt publication or change event ordering.
    }
  }

  const frame = encodeAuditSseFrame(event);
  for (const listener of [...sseListeners]) {
    try {
      listener(frame);
    } catch {
      // A broken transport is isolated from the audit publisher.
    }
  }
}

export function getAuditEvents(): readonly AuditEvent[] {
  return events.map((event) => ({ ...event, metadata: { ...event.metadata } }));
}

/** Test/lifecycle reset; does not opt the channel in or out. */
export function clearAuditEvents(): void {
  events.length = 0;
  nextId = 1;
}

export function subscribeAuditEvents(listener: AuditEventListener): () => void {
  if (!enabled) {
    return () => undefined;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to already-framed SSE audit events. */
export function subscribeAuditSse(listener: AuditSseListener): () => void {
  if (!enabled) {
    return () => undefined;
  }
  sseListeners.add(listener);
  return () => sseListeners.delete(listener);
}

/** Create a live SSE stream. Disabled channels return an already-closed stream. */
export function createAuditSseStream(): ReadableStream<string> {
  if (!enabled) {
    return new ReadableStream<string>({
      start(controller) {
        controller.close();
      }
    });
  }

  let unsubscribe: (() => void) | undefined;
  return new ReadableStream<string>({
    start(controller) {
      unsubscribe = subscribeAuditSse((frame) => {
        try {
          controller.enqueue(frame);
        } catch {
          unsubscribe?.();
        }
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  });
}

function encodeAuditSseFrame(event: AuditEvent): string {
  return `id: ${event.id}\nevent: audit\ndata: ${JSON.stringify(event)}\n\n`;
}

function sanitizeMetadata(input: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean | null>> {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      metadata[key] = value;
      continue;
    }
    if (typeof value === "string") {
      metadata[key] = scrubSecretValues(value);
    }
  }
  return metadata;
}
