/**
 * A tiny process-wide registry the credential resolver (directChat) and the wire
 * header builder (providerWire) both consult for guru's OWN vaulted OAuth tokens.
 * Kept standalone (no vault/model import) to avoid an import cycle; the controller
 * (guru.ts) registers an accessor that reads the encrypted vault.
 *
 * Sync by design — the resolver is sync. Token REFRESH is async and owned by the
 * controller (pre-connect + on-401); this only hands back whatever is stored now.
 */

export interface ResolvedOAuthToken {
  readonly accessToken: string;
  readonly accountId?: string;
}

let accessor: ((providerId: string) => ResolvedOAuthToken | null) | null = null;

export function registerOAuthTokenAccessor(fn: (providerId: string) => ResolvedOAuthToken | null): void {
  accessor = fn;
}

export function clearOAuthTokenAccessor(): void {
  accessor = null;
}

export function resolveOAuthTokenFor(providerId: string): ResolvedOAuthToken | null {
  return accessor ? accessor(providerId) : null;
}
