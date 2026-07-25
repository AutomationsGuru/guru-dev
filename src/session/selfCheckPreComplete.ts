/**
 * Completion is available only after every declared self-check has passed.
 */
export function canComplete(checks: readonly boolean[]): boolean {
  return checks.every((check) => check);
}
