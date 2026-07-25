export interface CredentialRoundRobinOptions {
  /** Milliseconds a failed credential remains unavailable. */
  readonly backoffMs?: number;
  /** Injectable clock for deterministic callers and tests. */
  readonly now?: () => number;
}

/**
 * Selects opaque credential identifiers fairly while keeping a healthy
 * credential pinned to a session until it fails or enters backoff.
 */
export class CredentialRoundRobin {
  private readonly credentialIds: readonly string[];
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly failuresUntil = new Map<string, number>();
  private readonly sessionAffinities = new Map<string, string>();
  private nextIndex = 0;

  constructor(credentialIds: readonly string[], options: CredentialRoundRobinOptions = {}) {
    this.credentialIds = [...new Set(credentialIds)];
    this.backoffMs = options.backoffMs ?? 60_000;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.backoffMs) || this.backoffMs < 0) {
      throw new Error("Credential backoff must be a non-negative finite duration.");
    }
  }

  pick(sessionId?: string): string | undefined {
    const affinity = sessionId === undefined ? undefined : this.sessionAffinities.get(sessionId);
    if (affinity !== undefined && this.isAvailable(affinity)) {
      return affinity;
    }

    if (sessionId !== undefined) {
      this.sessionAffinities.delete(sessionId);
    }

    const credentialId = this.pickNextAvailable();
    if (credentialId !== undefined && sessionId !== undefined) {
      this.sessionAffinities.set(sessionId, credentialId);
    }

    return credentialId;
  }

  markFail(credentialId: string): void {
    if (!this.credentialIds.includes(credentialId)) {
      return;
    }

    this.failuresUntil.set(credentialId, this.now() + this.backoffMs);
    for (const [sessionId, affinity] of this.sessionAffinities) {
      if (affinity === credentialId) {
        this.sessionAffinities.delete(sessionId);
      }
    }
  }

  private pickNextAvailable(): string | undefined {
    for (let offset = 0; offset < this.credentialIds.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.credentialIds.length;
      const credentialId = this.credentialIds[index];
      if (credentialId !== undefined && this.isAvailable(credentialId)) {
        this.nextIndex = (index + 1) % this.credentialIds.length;
        return credentialId;
      }
    }

    return undefined;
  }

  private isAvailable(credentialId: string): boolean {
    const failedUntil = this.failuresUntil.get(credentialId);
    if (failedUntil === undefined) {
      return true;
    }

    if (this.now() >= failedUntil) {
      this.failuresUntil.delete(credentialId);
      return true;
    }

    return false;
  }
}
