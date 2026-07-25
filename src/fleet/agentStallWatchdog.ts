/**
 * Returns whether an agent has exceeded its allowed no-progress interval.
 */
export function isStalled(last: number, now: number, timeout: number): boolean {
  return now - last > timeout;
}
