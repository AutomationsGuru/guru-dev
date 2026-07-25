export interface JournalEvent {
  /** When the event occurred (e.g. ISO string) */
  timestamp: string;
  /** Type of event, e.g. "decision", "tool" */
  kind: string;
  /**
   * Flat metadata key-value pairs.
   * Tool inputs and outputs must be omitted before calling append.
   */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export type AppendResult =
  | { type: "ok" }
  | { type: "capacity_exceeded" };

export interface TurnJournalOptions {
  /** Maximum number of records to retain in memory */
  maxCapacity: number;
  /** Redaction hook to scrub every printable string */
  sanitizer: (text: string) => string;
}

export class TurnJournal {
  private readonly events: JournalEvent[] = [];
  private readonly maxCapacity: number;
  private readonly sanitizer: (text: string) => string;

  constructor(options: TurnJournalOptions) {
    if (options.maxCapacity <= 0) {
      throw new Error("maxCapacity must be strictly positive");
    }
    this.maxCapacity = Math.floor(options.maxCapacity);
    this.sanitizer = options.sanitizer;
  }

  /**
   * Appends an event to the journal.
   * If the journal has reached its finite capacity, returns capacity_exceeded
   * and preserves existing records.
   */
  append(event: JournalEvent): AppendResult {
    if (this.events.length >= this.maxCapacity) {
      return { type: "capacity_exceeded" };
    }

    const sanitizedEvent: JournalEvent = {
      timestamp: this.sanitizer(String(event.timestamp ?? "")),
      kind: this.sanitizer(String(event.kind ?? "")),
      metadata: {},
    };

    if (event.metadata) {
      for (const [key, value] of Object.entries(event.metadata)) {
        const sanitizedKey = this.sanitizer(String(key));
        if (typeof value === "string") {
          sanitizedEvent.metadata![sanitizedKey] = this.sanitizer(value);
        } else {
          sanitizedEvent.metadata![sanitizedKey] = value;
        }
      }
    }

    this.events.push(sanitizedEvent);
    return { type: "ok" };
  }

  /**
   * Exports the journal as a human-readable Markdown string for evidence packs.
   */
  exportMarkdown(): string {
    if (this.events.length === 0) {
      return "*No journal events recorded.*";
    }

    const lines: string[] = ["# Turn Journal", ""];

    for (const event of this.events) {
      lines.push(`## [${event.timestamp}] ${event.kind}`);

      if (event.metadata) {
        const keys = Object.keys(event.metadata).sort();
        if (keys.length > 0) {
          lines.push("");
          for (const key of keys) {
            const value = event.metadata[key];
            lines.push(`- **${key}**: ${value}`);
          }
        }
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }
}
