import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isTrusted, trust, listTrusted, getTrustFilePath } from '../../src/security/trustFolder.js';

describe("trustFolder", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "guruharness-trust-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. isTrusted returns false for untrusted path
  // -----------------------------------------------------------------------
  it("returns false for an untrusted path", () => {
    expect(isTrusted("/some/random/path", homeDir)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 2. isTrusted returns true after trust()
  // -----------------------------------------------------------------------
  it("returns true after a path is trusted", () => {
    trust("/tmp/my-project", homeDir);
    expect(isTrusted("/tmp/my-project", homeDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. isTrusted returns true for nested child of trusted parent
  // -----------------------------------------------------------------------
  it("returns true for nested child directories of a trusted parent", () => {
    trust("/tmp/trusted-parent", homeDir);
    expect(isTrusted("/tmp/trusted-parent/child", homeDir)).toBe(true);
    expect(isTrusted("/tmp/trusted-parent/deep/nested", homeDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. isTrusted returns false for parent of trusted child
  // -----------------------------------------------------------------------
  it("returns false for a parent of a trusted child (directional trust)", () => {
    trust("/tmp/somewhere/deep/trusted-child", homeDir);
    expect(isTrusted("/tmp/somewhere/deep", homeDir)).toBe(false);
    expect(isTrusted("/tmp/somewhere", homeDir)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. trust() is idempotent
  // -----------------------------------------------------------------------
  it("is idempotent — trusting the same path twice stores it once", () => {
    trust("/tmp/singleton", homeDir);
    trust("/tmp/singleton", homeDir);
    trust("/tmp/singleton", homeDir);
    expect(listTrusted(homeDir)).toEqual(["/tmp/singleton"]);
  });

  // -----------------------------------------------------------------------
  // 6. trust() persists to disk
  // -----------------------------------------------------------------------
  it("persists trusted paths to disk", async () => {
    trust("/tmp/persisted", homeDir);
    // A fresh read via listTrusted should see the persisted entry.
    expect(listTrusted(homeDir)).toEqual(["/tmp/persisted"]);
  });

  // -----------------------------------------------------------------------
  // 7. listTrusted() returns empty for missing file
  // -----------------------------------------------------------------------
  it("returns empty when the trust file does not exist", () => {
    expect(listTrusted(homeDir)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 8. listTrusted() returns empty for corrupt file (fails closed)
  // -----------------------------------------------------------------------
  it("returns empty for a corrupt trust file (fails closed)", async () => {
    const filePath = getTrustFilePath(homeDir);
    await writeFile(filePath, "this is not valid JSON");
    expect(listTrusted(homeDir)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 9. listTrusted() returns empty for wrong schema version
  // -----------------------------------------------------------------------
  it("returns empty when the schema version is unrecognized", async () => {
    const filePath = getTrustFilePath(homeDir);
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 99, trusted: ["/fake"] })
    );
    expect(listTrusted(homeDir)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 10. getTrustFilePath() returns the correct path
  // -----------------------------------------------------------------------
  it("returns the correct path for the trust file", () => {
    expect(getTrustFilePath(homeDir)).toBe(join(homeDir, "trusted.json"));
  });

  // -----------------------------------------------------------------------
  // 11. Paths are normalized (trailing slash, relative segments)
  // -----------------------------------------------------------------------
  it("normalizes paths so different representations compare equal", () => {
    trust("/tmp/my-folder/", homeDir); // trailing slash
    expect(isTrusted("/tmp/my-folder", homeDir)).toBe(true);
    expect(isTrusted("/tmp/my-folder/", homeDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 12. Multiple trusted paths
  // -----------------------------------------------------------------------
  it("tracks multiple trusted paths", () => {
    trust("/tmp/first", homeDir);
    trust("/tmp/second", homeDir);
    expect(listTrusted(homeDir)).toEqual(["/tmp/first", "/tmp/second"]);
  });
});
