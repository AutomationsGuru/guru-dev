export interface WaitReadyOptions {
  readonly isReady: () => boolean;
  readonly timeoutMs: number;
  readonly now: () => number;
}

export function waitReady({ isReady, timeoutMs, now }: WaitReadyOptions): void {
  if (isReady()) {
    return;
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (isReady()) {
      return;
    }
  }

  throw new Error(`Sandbox did not become ready within ${timeoutMs}ms.`);
}
