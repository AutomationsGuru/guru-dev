/**
 * Select the policy-preferred shell backend when it is available, otherwise use
 * the first available backend. This helper does not execute or initialize one.
 */
export function selectShellBackend(policy: string, available: readonly string[]): string | undefined {
  return available.includes(policy) ? policy : available[0];
}
