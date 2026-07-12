/**
 * Shared TUI interaction gate — when a modal prompt (approval, ask_question)
 * owns stdin, the composer must not accumulate steer drafts from the same keys.
 *
 * Module-level so tools created at session boot can open the gate without a
 * circular import into guru.ts.
 */

let openCount = 0;

/** True while any interactive modal owns the next keystrokes. */
export function isInteractionGateOpen(): boolean {
  return openCount > 0;
}

/** Run `fn` with the gate held open (nested-safe). */
export async function withInteractionGate<T>(fn: () => Promise<T>): Promise<T> {
  openCount += 1;
  try {
    return await fn();
  } finally {
    openCount = Math.max(0, openCount - 1);
  }
}
