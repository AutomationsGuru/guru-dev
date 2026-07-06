import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * The credential vault (Credential Vault wave, ADR 2026-07-06-credential-vault) —
 * a small, encrypted, machine-local store for API keys, as a first-class ALTERNATIVE
 * to environment variables. It exists because some keys can't live in env (e.g.
 * ANTHROPIC_API_KEY conflicts with a Claude Max auth token in the same shell), yet
 * the operator wants guru to light up those providers automatically on launch.
 *
 * SHAPE: AES-256-GCM ciphertext at ~/.guruharness/vault.enc. The key is derived from
 * either GURU_VAULT_PASSPHRASE (scrypt) or an auto-generated machine key file
 * (~/.guruharness/vault.key, 32 random bytes, 0600). The plaintext is a flat
 * name→value map keyed by the SAME env-var names providers already resolve by, so a
 * vault entry `ANTHROPIC_API_KEY` behaves exactly like the env var of that name.
 *
 * THREAT MODEL (honest): the vault is encrypted at rest and never committed/greppable.
 * With the default key-file mode the key sits on the same machine (0600) — this is
 * obfuscation-grade against casual/accidental exposure and git, NOT against a
 * determined local attacker with full home-dir read. Set GURU_VAULT_PASSPHRASE for a
 * passphrase-derived key that never touches disk. Values are never printed or logged;
 * listing shows NAMES only (presence-over-value).
 */

const VAULT_SUBDIR = ".guruharness";
const VAULT_FILE = "vault.enc";
const KEY_FILE = "vault.key";
const PASSPHRASE_ENV = "GURU_VAULT_PASSPHRASE";
const SCHEMA_VERSION = 1;

interface VaultEnvelope {
  readonly v: number;
  readonly kdf: "keyfile" | "scrypt";
  readonly salt?: string; // base64 (scrypt only)
  readonly iv: string; // base64
  readonly tag: string; // base64
  readonly ct: string; // base64
}

export interface VaultOptions {
  /** Home dir override (tests). Defaults to os.homedir(). */
  readonly home?: string;
  /** Passphrase override (tests / explicit). Defaults to env GURU_VAULT_PASSPHRASE. */
  readonly passphrase?: string;
  /** env override (tests). Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface Vault {
  /** The value for a name, or undefined. */
  get(name: string): string | undefined;
  has(name: string): boolean;
  /** The stored names — NEVER the values (presence-over-value). */
  names(): string[];
  readonly size: number;
  /** The KDF the vault is (or will be) encrypted with. */
  readonly kdf: "keyfile" | "scrypt";
  set(name: string, value: string): void;
  remove(name: string): boolean;
  /** Encrypt + persist atomically (0600). No-op-safe to call after any mutation. */
  save(): void;
  readonly filePath: string;
}

function vaultDir(home: string): string {
  return join(home, VAULT_SUBDIR);
}

/** Resolve (and, in keyfile mode, lazily create) the 32-byte encryption key + KDF. */
function resolveKey(home: string, passphrase: string | undefined, salt: Buffer | undefined): { key: Buffer; kdf: "keyfile" | "scrypt"; salt?: Buffer } {
  if (passphrase && passphrase.length > 0) {
    const useSalt = salt ?? randomBytes(16);
    return { key: scryptSync(passphrase, useSalt, 32), kdf: "scrypt", salt: useSalt };
  }
  const keyPath = join(vaultDir(home), KEY_FILE);
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath);
    if (key.length === 32) {
      return { key, kdf: "keyfile" };
    }
  }
  // First use with no passphrase: mint a machine-local key, 0600.
  mkdirSync(vaultDir(home), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort perms (Windows tolerates the mode flag but not chmod semantics)
  }
  return { key, kdf: "keyfile" };
}

function decrypt(envelope: VaultEnvelope, home: string, passphrase: string | undefined): Record<string, string> {
  const salt = envelope.salt ? Buffer.from(envelope.salt, "base64") : undefined;
  const { key } = resolveKey(home, envelope.kdf === "scrypt" ? passphrase : undefined, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf8");
  const parsed: unknown = JSON.parse(plain);
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Open the vault: decrypt the file into memory (empty if absent). A wrong key /
 * tampered file throws (GCM auth failure) — callers surface a clear message rather
 * than silently starting empty, so a mis-keyed vault never looks like "no keys".
 */
export function openVault(options: VaultOptions = {}): Vault {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const passphrase = options.passphrase ?? env[PASSPHRASE_ENV];
  const filePath = join(vaultDir(home), VAULT_FILE);

  let entries: Record<string, string> = {};
  let kdf: "keyfile" | "scrypt" = passphrase && passphrase.length > 0 ? "scrypt" : "keyfile";
  if (existsSync(filePath)) {
    const envelope = JSON.parse(readFileSync(filePath, "utf8")) as VaultEnvelope;
    entries = decrypt(envelope, home, passphrase);
    kdf = envelope.kdf;
  }

  return {
    filePath,
    kdf,
    get(name) {
      return entries[name];
    },
    has(name) {
      return Object.prototype.hasOwnProperty.call(entries, name);
    },
    names() {
      return Object.keys(entries).sort();
    },
    get size() {
      return Object.keys(entries).length;
    },
    set(name, value) {
      entries[name] = value;
    },
    remove(name) {
      if (Object.prototype.hasOwnProperty.call(entries, name)) {
        delete entries[name];
        return true;
      }
      return false;
    },
    save() {
      const { key, kdf: usedKdf, salt } = resolveKey(home, passphrase, undefined);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
      const envelope: VaultEnvelope = {
        v: SCHEMA_VERSION,
        kdf: usedKdf,
        ...(salt ? { salt: salt.toString("base64") } : {}),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64")
      };
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
      renameSync(tmp, filePath);
      try {
        chmodSync(filePath, 0o600);
      } catch {
        // best-effort perms
      }
    }
  };
}
