/**
 * System reminder injector (IDEA-F391-REMIND-01).
 *
 * Appends bounded reminder strings by trigger into an existing reminder set,
 * without duplicating a reminder that already carries the same id. Pure and
 * allocation-light — it never mutates its inputs and keeps the reminder stream
 * small so per-turn system context cannot grow without limit (memory-noise /
 * weight discipline).
 *
 * This is an owned, framework-free runtime helper. It owns its data shape
 * locally and is exercised by tests/session/systemReminderInjector.test.ts.
 */

/** What condition emits a reminder (carried for diagnostics/routing only). */
export type SystemReminderTrigger = string;

/** A single system reminder line, uniquely identified by `id`. */
export interface SystemReminder {
  /** Stable dedup key. Two reminders with the same id are the same reminder. */
  readonly id: string;
  /** Human-readable reminder text appended to the system context. */
  readonly text: string;
  /** Why this reminder is being emitted right now. */
  readonly trigger: SystemReminderTrigger;
}

/** Default hard caps that keep the reminder stream bounded. */
export const DEFAULT_REMINDER_LIMIT = 16;
export const DEFAULT_REMINDER_TEXT_MAX = 1024;

export interface InjectOptions {
  /** Maximum number of reminders retained after injection. */
  readonly limit?: number;
  /** Maximum characters per reminder text; longer text is truncated. */
  readonly textMax?: number;
}

export interface InjectResult {
  /** Existing reminders followed by newly accepted ones, in insertion order, deduped by id. */
  readonly reminders: readonly SystemReminder[];
  /** Ids from `reminders` that were dropped because an equal id was already present. */
  readonly droppedIds: readonly string[];
}

const EMPTY: InjectResult = { reminders: [], droppedIds: [] };

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Merge candidate `reminders` into `existing`, dropping any candidate whose
 * `id` already appears in `existing` or earlier in the candidate list.
 *
 * Inputs are never mutated. The returned reminder list is bounded by `limit`
 * (default {@link DEFAULT_REMINDER_LIMIT}); when injection would exceed the
 * bound, the most recently appended candidates are trimmed first so existing
 * reminders survive. Reminder text longer than `textMax` (default
 * {@link DEFAULT_REMINDER_TEXT_MAX}) is truncated with an ellipsis marker.
 */
export function injectSystemReminders(
  reminders: readonly SystemReminder[],
  existing: readonly SystemReminder[] = [],
  options: InjectOptions = {}
): InjectResult {
  const limit = clampPositive(options.limit, DEFAULT_REMINDER_LIMIT);
  const textMax = clampPositive(options.textMax, DEFAULT_REMINDER_TEXT_MAX);

  if ((!existing || existing.length === 0) && (!reminders || reminders.length === 0)) {
    return EMPTY;
  }

  const seen = new Set<string>();
  const merged: SystemReminder[] = [];
  const droppedIds: string[] = [];

  const push = (reminder: SystemReminder): void => {
    const text = reminder.text.length > textMax ? `${reminder.text.slice(0, textMax - 1)}…` : reminder.text;
    merged.push(text === reminder.text ? reminder : { ...reminder, text });
  };

  for (const reminder of existing) {
    if (!reminder || seen.has(reminder.id)) continue;
    seen.add(reminder.id);
    push(reminder);
  }

  for (const candidate of reminders) {
    if (!candidate) continue;
    if (seen.has(candidate.id)) {
      droppedIds.push(candidate.id);
      continue;
    }
    seen.add(candidate.id);
    push(candidate);
  }

  // Bound the stream. Established (existing) reminders are anchored at the
  // front, so overflow trims the most recently appended candidates first —
  // keep the first `limit` entries in insertion order.
  if (merged.length > limit) {
    merged.splice(limit, merged.length - limit);
  }

  return { reminders: merged, droppedIds };
}
