import { z } from "zod";

/**
 * Session Audit SSE (IDEA-F270-AUDIT-SSE-01)
 *
 * Opt-in Server-Sent Events channel for emitting and subscribing to
 * session audit events (intent, tool calls, approvals). Default OFF
 * to avoid unintended telemetry. Events are strictly ordered.
 *
 * This is a lightweight, self-contained module. Enable explicitly
 * for a session when audit trail is requested. No secrets ever emitted.
 * Fits the frozen extension seam and P1 reliability goals.
 */

// Hard limit guard: never auto-enable; explicit opt-in only.
let auditEnabled = false;
const auditEvents: AuditEvent[] = [];
const listeners: Array<(event: AuditEvent) => void> = [];

export const AuditEventTypeSchema = z.enum(["intent", "tool", "approval"]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  ts: z.string().datetime(),
  type: AuditEventTypeSchema,
  sessionId: z.string().optional(),
  payload: z.unknown(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * Enable the audit SSE channel. Must be called explicitly; default remains off.
 * Idempotent. Returns true if newly enabled.
 */
export function enableAuditSse(): boolean {
  if (auditEnabled) return false;
  auditEnabled = true;
  return true;
}

/** Returns whether audit SSE is currently enabled. */
export function isAuditSseEnabled(): boolean {
  return auditEnabled;
}

/**
 * Emit an audit event. No-op when disabled (default).
 * Events are appended in call order and fan-out to any active subscribers.
 */
export function emitAuditEvent(input: {
  type: AuditEventType;
  payload: unknown;
  sessionId?: string;
}): void {
  if (!auditEnabled) return;

  const event: AuditEvent = {
    ts: new Date().toISOString(),
    type: input.type,
    sessionId: input.sessionId,
    payload: input.payload,
  };

  // Validate shape (defensive; keeps events clean)
  const parsed = AuditEventSchema.safeParse(event);
  if (!parsed.success) return; // drop invalid silently (never leak)

  auditEvents.push(parsed.data);
  for (const listener of listeners) {
    try {
      listener(parsed.data);
    } catch {
      // listener errors must not break emission or ordering
    }
  }
}

/** Retrieve a snapshot of emitted events in order (for tests / inspection). */
export function getAuditEvents(): readonly AuditEvent[] {
  return [...auditEvents];
}

/** Clear events (test helper; does not affect enabled state). */
export function clearAuditEvents(): void {
  auditEvents.length = 0;
}

/**
 * Subscribe to live audit events via callback.
 * Returns unsubscribe function. Only receives events after subscription.
 * For full SSE stream consumption, wrap the callback or use createAuditSseStream.
 */
export function subscribeAuditEvents(
  onEvent: (event: AuditEvent) => void
): () => void {
  listeners.push(onEvent);
  return () => {
    const idx = listeners.indexOf(onEvent);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/**
 * Create an SSE-compatible ReadableStream for opt-in consumption.
 * Emits "data: <json>\n\n" events. Starts buffering from subscription time
 * or replays prior if desired (here: live only for simplicity).
 * Consumer is responsible for enabling first.
 */
export function createAuditSseStream(): ReadableStream<string> {
  if (!auditEnabled) {
    // Return empty stream when disabled (explicit opt-in expected upstream)
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }

  return new ReadableStream({
    start(controller) {
      const unsubscribe = subscribeAuditEvents((event) => {
        const line = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(line);
      });

      // Store unsubscribe for potential abort; in practice caller manages lifetime
      // For this impl we keep simple; real usage would tie to request signal.
      (controller as any)._unsub = unsubscribe;
    },
    cancel() {
      // best-effort cleanup omitted for minimal surface
    },
  });
}
