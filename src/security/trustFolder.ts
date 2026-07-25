import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { resolveGuruHomeDirectory } from "../home/paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TrustedListSchema = z
  .object({
    schemaVersion: z.literal(1),
    trusted: z.array(z.string())
  })
  .strict();

export type TrustedList = z.infer<typeof TrustedListSchema>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  // resolve(".")  collapses relative segments and platform separators but may
  // leave a trailing separator when the input had one.  Strip it explicitly so
  // /tmp/foo  and  /tmp/foo/  compare equal.
  let normalized = resolve(path);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function readTrustedList(homeDir?: string): TrustedList {
  const filePath = getTrustFilePath(homeDir);
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed = TrustedListSchema.safeParse(raw);
    return parsed.success ? parsed.data : { schemaVersion: 1, trusted: [] };
  } catch {
    return { schemaVersion: 1, trusted: [] };
  }
}

function writeTrustedList(list: TrustedList, homeDir?: string): void {
  const filePath = getTrustFilePath(homeDir);
  const directory = dirname(filePath);

  mkdirSync(directory, { recursive: true });

  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the file-system path to the persisted trust file.
 *
 * @param homeDir  Optional override for the directory containing `trusted.json`.
 *                 Defaults to `~/.guruharness`.
 */
export function getTrustFilePath(homeDir?: string): string {
  return join(
    homeDir ?? resolveGuruHomeDirectory(),
    "trusted.json"
  );
}

/**
 * Returns `true` when *path* — or any ancestor directory — has been explicitly
 * trusted.
 *
 * Trust is directional (parent → child): trusting `/a/b` also trusts `/a/b/c`
 * and `/a/b/c/d`, but trusting `/a/b/c` does NOT trust `/a/b`.
 *
 * Fails closed — returns `false` when the trust file is missing or corrupt.
 */
export function isTrusted(path: string, homeDir?: string): boolean {
  const resolved = normalizePath(path);
  const { trusted } = readTrustedList(homeDir);

  for (const entry of trusted) {
    const normalizedEntry = normalizePath(entry);
    if (
      resolved === normalizedEntry ||
      (resolved.startsWith(normalizedEntry) &&
        resolved[normalizedEntry.length] === "/")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Persist *path* as trusted.
 *
 * The path is resolved to an absolute form, deduplicated against the existing
 * list, and written to disk atomically.  Calling this more than once with the
 * same path is idempotent.
 *
 * The home-directory tree is created lazily when it does not exist yet.
 */
export function trust(path: string, homeDir?: string): void {
  const resolved = normalizePath(path);
  const { trusted } = readTrustedList(homeDir);

  if (trusted.includes(resolved)) {
    return; // idempotent
  }

  writeTrustedList(
    { schemaVersion: 1, trusted: [...trusted, resolved] },
    homeDir
  );
}

/**
 * Return a **readonly copy** of every trusted path.
 *
 * Returns an empty array when no trust file exists or the file is corrupt
 * (fails closed).
 */
export function listTrusted(homeDir?: string): readonly string[] {
  return [...readTrustedList(homeDir).trusted];
}
