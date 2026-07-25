import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * TurnEventLog — the append-only record of what happened inside a session's
 * turns (IDEA-F163-TURN-REPLAY-01 / R-ZG-REPLAY, Zagens K6 event-sourced turn
 * log). Every entry is one typed event — user input, assistant output, a tool
 * invocation, or an explicit decision point — carrying an opaque payload and a
 * caller-supplied timestamp (injected `now`, never a hidden clock read).
 *
 * The log is the audit spine: append-only in memory, sealed into an
 * export pack by hash-chaining every entry so truncation, reordering, and
 * tampering are detectable offline (composes F126 export + F77 trajectory
 * residuals). `turnEventReplay.ts` consumes the pack for dry-run replay
 * verification without re-calling any model.
 */

export const TURN_EVENT_LOG_VERSION = 1 as const;

export const TurnEventKindSchema = z.enum(["user", "assistant", "tool", "decision"]);
export type TurnEventKind = z.infer<typeof TurnEventKindSchema>;

/** Payloads stay opaque to the log; redaction/scrubbing is the producer's job. */
export const TurnEventPayloadSchema = z.record(z.string(), z.unknown());
export type TurnEventPayload = z.infer<typeof TurnEventPayloadSchema>;

export const TurnEventSchema = z
  .object({
    seq: z.number().int().positive(),
    turn: z.number().int().positive(),
    kind: TurnEventKindSchema,
    at: z.string().min(1),
    payload: TurnEventPayloadSchema
  })
  .strict();
export type TurnEvent = z.infer<typeof TurnEventSchema>;

export const TurnEventInputSchema = TurnEventSchema.omit({ seq: true });
export type TurnEventInput = z.infer<typeof TurnEventInputSchema>;

export interface TurnEventListFilter {
  readonly turn?: number;
  readonly kind?: TurnEventKind;
}

const EntryHashesSchema = z.array(z.string().regex(/^[0-9a-f]{64}$/));

export const TurnEventPackSchema = z
  .object({
    version: z.literal(TURN_EVENT_LOG_VERSION),
    createdAt: z.string().min(1),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    count: z.number().int().nonnegative(),
    entryHashes: EntryHashesSchema,
    events: z.array(TurnEventSchema)
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (pack.entryHashes.length !== pack.events.length || pack.count !== pack.events.length) {
      ctx.addIssue({ code: "custom", message: "count/entryHashes length must match events length" });
    }
  });
export type TurnEventPack = z.infer<typeof TurnEventPackSchema>;

export function hashTurnEvent(event: TurnEvent): string {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

/** Deterministic serialization: object keys sorted recursively, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export class TurnEventLog {
  #events: TurnEvent[] = [];

  /** Append the next event. `seq` is assigned as prior length + 1 and never reused. */
  append(input: TurnEventInput): TurnEvent {
    const event: TurnEvent = { ...input, seq: this.#events.length + 1 };
    this.#events.push(event);
    return event;
  }

  get size(): number {
    return this.#events.length;
  }

  /** Read-only view, optionally narrowed by turn and/or kind. */
  list(filter: TurnEventListFilter = {}): readonly TurnEvent[] {
    return this.#events.filter(
      (event) =>
        (filter.turn === undefined || event.turn === filter.turn) &&
        (filter.kind === undefined || event.kind === filter.kind)
    );
  }

  /**
   * Seal the log into a self-verifying export pack: each event is hashed
   * (canonical JSON → sha256) and chained into `head`; `createdAt` comes from
   * the caller's clock so export stays deterministic under test.
   */
  exportPack(createdAt: string): TurnEventPack {
    const events = this.list();
    const entryHashes = events.map(hashTurnEvent);
    const head = createHash("sha256").update(entryHashes.join("\n")).digest("hex");
    return {
      version: TURN_EVENT_LOG_VERSION,
      createdAt,
      head,
      count: events.length,
      entryHashes,
      events: [...events]
    };
  }

  /** Serialize the export pack for persistence/transport. */
  exportPackJson(createdAt: string): string {
    return `${JSON.stringify(this.exportPack(createdAt), null, 2)}\n`;
  }
}

/** Parse an untrusted export pack. Throws ZodError on any shape violation. */
export function parseTurnEventPack(raw: unknown): TurnEventPack {
  return TurnEventPackSchema.parse(raw);
}

/** Parse an export pack from its JSON text form. Throws on invalid JSON or shape. */
export function parseTurnEventPackJson(json: string): TurnEventPack {
  return parseTurnEventPack(JSON.parse(json));
}
