/**
 * Test-only path comparison helpers.
 *
 * On Windows the casing of the OS user directory can disagree between sources
 * for the same physical path: `os.tmpdir()` / `fs.mkdtempSync()` may return
 * `C:SERSSER\...` while `git rev-parse --show-toplevel` returns
 * `C:SERSSER\...`. NTFS (and the temp directory beneath it) is
 * case-insensitive, so both strings denote the same directory. Comparing
 * normalized, lower-cased forms avoids spurious assertion failures without
 * weakening any production path handling.
 */
import { normalize } from "node:path";

export function normalizePathForCompare(value: string): string {
  return normalize(value).toLowerCase();
}

export function expectSamePath(actual: unknown, expected: string): void {
  expect(typeof actual).toBe("string");
  expect(normalizePathForCompare(actual as string)).toBe(normalizePathForCompare(expected));
}
