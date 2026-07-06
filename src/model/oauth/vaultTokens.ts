import type { Vault } from "../../safety/vault.js";
import type { GuruOAuthToken } from "./openaiCodexLogin.js";

/**
 * Store/read guru's OWN OAuth token record in the encrypted vault (AES-256-GCM),
 * serialized as a JSON string under a reserved `oauth:<providerId>` key — so the
 * existing flat name→string vault needs no format change, and the token lives
 * encrypted at rest, never as a plaintext file and never from another tool's cache.
 */

const KEY_PREFIX = "oauth:";

export function oauthVaultKey(providerId: string): string {
  return `${KEY_PREFIX}${providerId}`;
}

export function isOAuthVaultKey(name: string): boolean {
  return name.startsWith(KEY_PREFIX);
}

export function readVaultOAuthToken(vault: Vault, providerId: string): GuruOAuthToken | null {
  const raw = vault.get(oauthVaultKey(providerId));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as GuruOAuthToken;
  } catch {
    return null;
  }
}

export function writeVaultOAuthToken(vault: Vault, providerId: string, token: GuruOAuthToken): void {
  vault.set(oauthVaultKey(providerId), JSON.stringify(token));
  vault.save();
}

export function removeVaultOAuthToken(vault: Vault, providerId: string): boolean {
  const existed = vault.remove(oauthVaultKey(providerId));
  if (existed) {
    vault.save();
  }
  return existed;
}
