/**
 * Parse-verification for the frozen restore manifest schema (Dev 4 skeleton).
 * Proves FR-22 manifest shape compiles and enforces the mandatory secret scan.
 */

import { describe, expect, it } from "vitest";

import { RestoreManifestSchema } from "../../src/restore/manifests.js";

describe("restore manifest schema", () => {
  it("parses a clean manifest with defaults and a passing secret scan", () => {
    const parsed = RestoreManifestSchema.parse({
      version: "0.1.0",
      generatedAt: "2026-06-23T00:00:00.000Z",
      secretScan: { scannedAt: "2026-06-23T00:00:00.000Z", scanner: "guruharness-secret-scan" }
    });
    expect(parsed.harness).toBe("GuruHarness");
    expect(parsed.components).toEqual([]);
    expect(parsed.configSummary.envNames).toEqual([]);
    expect(parsed.secretScan.leakedSecretCount).toBe(0);
  });

  it("rejects a manifest without the mandatory secretScan block", () => {
    expect(() =>
      RestoreManifestSchema.parse({
        version: "0.1.0",
        generatedAt: "2026-06-23T00:00:00.000Z"
      })
    ).toThrow();
  });
});
