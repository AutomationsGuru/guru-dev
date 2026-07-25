/**
 * kernelTraceExport — serializes the kernel/turn event log to a redacted report
 * object for operator download. The redact hook is supplied by the caller so
 * secret stripping stays outside this module and is enforced at the call site.
 *
 * Part of IDEA-F204-TRACE-EXPORT-01 (R-ZG-TRACE). Minimal surface: event count
 * + redacted payload. No Zagens rehost, no core mutation.
 */

export interface KernelTraceReport {
  readonly eventCount: number;
  readonly generatedAt: string;
  readonly redactedEvents: readonly unknown[];
}

/**
 * exportReport — produces a redacted, serializable trace report.
 * redact is invoked on string values encountered; non-strings are passed through.
 */
export function exportReport(
  events: ReadonlyArray<unknown>,
  redact: (input: string) => string
): KernelTraceReport {
  const redactedEvents = events.map((event) => {
    if (typeof event === "string") {
      return redact(event);
    }
    if (event && typeof event === "object") {
      // shallow redaction of string leaves for simple cases
      return JSON.parse(
        JSON.stringify(event, (_k, v) => (typeof v === "string" ? redact(v) : v))
      );
    }
    return event;
  });

  return {
    eventCount: events.length,
    generatedAt: new Date().toISOString(),
    redactedEvents,
  };
}
