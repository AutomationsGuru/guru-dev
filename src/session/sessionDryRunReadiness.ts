export function buildReport(input: { authToken?: string }) {
  const blocked: string[] = [];
  if (!input.authToken) {
    blocked.push('Authentication missing');
  }

  // TODO: Implement the rest of the report building logic
  const isReady = blocked.length === 0;

  return {
    ready: isReady,
    warnings: [],
    blocked,
    nextActions: [],
  };
}
