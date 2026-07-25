import { describe, expect, it } from "vitest";

import { requiresHitl } from '../../src/mandates/hitlGlobMatcher.js';

describe("requiresHitl — HITL glob matcher", () => {
  // ── Positive matches ──────────────────────────────────────────────

  it("matches a literal tool name exactly", () => {
    expect(requiresHitl("bash", ["bash"])).toBe(true);
  });

  it("matches a literal path exactly", () => {
    expect(requiresHitl("/home/user/.env", ["/home/user/.env"])).toBe(true);
  });

  it("matches * wildcard (single segment, no path separator)", () => {
    expect(requiresHitl("bash", ["*"])).toBe(true);
    expect(requiresHitl("web_fetch", ["*"])).toBe(true);
  });

  it("matches * within a path segment", () => {
    expect(requiresHitl("/home/user/config.json", ["/home/user/*.json"])).toBe(true);
    expect(requiresHitl("/home/user/data.json", ["/home/user/*.json"])).toBe(true);
  });

  it("matches ** globstar across path separators", () => {
    expect(requiresHitl("/home/user/.env", ["**/*.env"])).toBe(true);
    expect(requiresHitl("/a/b/c/d/.env", ["**/*.env"])).toBe(true);
    expect(requiresHitl(".env", ["**/*.env"])).toBe(true);
  });

  it("matches ** at the end to cover any descendant", () => {
    expect(requiresHitl("/home/user/.aws/credentials", ["/home/user/**"])).toBe(true);
    expect(requiresHitl("/home/user/deep/nested/file.txt", ["/home/user/**"])).toBe(true);
    expect(requiresHitl("/home/user/file.txt", ["/home/user/**"])).toBe(true);
  });

  it("matches ? single-character wildcard", () => {
    expect(requiresHitl("file1.txt", ["file?.txt"])).toBe(true);
    expect(requiresHitl("fileA.txt", ["file?.txt"])).toBe(true);
  });

  it("matches with multiple globs — first match wins", () => {
    expect(requiresHitl("bash", ["write", "bash", "edit"])).toBe(true);
  });

  it("matches with multiple globs — later match wins", () => {
    expect(requiresHitl("edit", ["write", "bash", "edit"])).toBe(true);
  });

  it("matches tool-like patterns with wildcards", () => {
    expect(requiresHitl("web_fetch", ["web_*"])).toBe(true);
    expect(requiresHitl("web_search", ["web_*"])).toBe(true);
    expect(requiresHitl("provider_cli_run", ["provider_*"])).toBe(true);
  });

  it("matches secrets-adjacent file patterns", () => {
    const secrets = ["**/*.env", "**/*.pem", "**/credentials*", "**/.npmrc", "**/id_rsa*"];
    expect(requiresHitl("/home/user/.env", secrets)).toBe(true);
    // .env.production does NOT end with .env — correct negative
    expect(requiresHitl("/project/sub/dir/.env.production", ["**/*.env"])).toBe(false);
    // but **/*.env* (with trailing wildcard) catches it
    expect(requiresHitl("/project/sub/dir/.env.production", ["**/*.env*"])).toBe(true);
    expect(requiresHitl("/home/user/.ssh/id_rsa", secrets)).toBe(true);
    expect(requiresHitl("/etc/ssl/certs/server.pem", secrets)).toBe(true);
    expect(requiresHitl("/app/credentials.json", secrets)).toBe(true);
    expect(requiresHitl("/home/user/.npmrc", secrets)).toBe(true);
  });

  it("matches Windows-style paths with globs", () => {
    expect(requiresHitl("C:\\Users\\test\\.env", ["**/*.env"])).toBe(true);
    expect(requiresHitl("C:\\Users\\test\\file.txt", ["C:\\Users\\**"])).toBe(true);
  });

  // ── Negative matches ──────────────────────────────────────────────

  it("returns false when no glob matches", () => {
    expect(requiresHitl("bash", ["write", "edit"])).toBe(false);
  });

  it("returns false for empty globs array", () => {
    expect(requiresHitl("bash", [])).toBe(false);
  });

  it("returns false when * does not cross path separators", () => {
    // * matches within a single segment, not across /
    expect(requiresHitl("/home/user/.env", ["*.env"])).toBe(false);
  });

  it("returns false when pattern is a near-miss on literal", () => {
    expect(requiresHitl("bash", ["bash2"])).toBe(false);
    expect(requiresHitl("web_fetch", ["web_fetch_extra"])).toBe(false);
  });

  it("returns false for empty input with non-empty globs", () => {
    expect(requiresHitl("", ["*.env"])).toBe(false);
  });

  it("returns false when ** globstar does not match prefix", () => {
    // **/*.env means "anything ending in .env" — this .txt isn't
    expect(requiresHitl("/home/user/file.txt", ["**/*.env"])).toBe(false);
  });

  it("returns false when path separator doesn't align", () => {
    // *.json only matches a single segment; a path with / won't match
    expect(requiresHitl("/home/user/data.json", ["*.json"])).toBe(false);
  });

  it("returns false for partial segment match without wildcard", () => {
    expect(requiresHitl("web_fetch", ["web"])).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("empty glob within a non-empty list is ignored (no false positive)", () => {
    // An empty string glob should not match everything
    expect(requiresHitl("bash", [""])).toBe(false);
    expect(requiresHitl("bash", ["write", "", "edit"])).toBe(false);
  });

  it("handles glob with special regex characters safely", () => {
    // Patterns containing regex metacharacters: ., +, (, ), etc.
    expect(requiresHitl("file.txt", ["file.txt"])).toBe(true); // literal dot
    expect(requiresHitl("file.txt", ["*.txt"])).toBe(true); // wildcard + dot
    expect(requiresHitl("(bash)", ["(bash)"])).toBe(true); // literal parens match literal parens — they are NOT regex groups here
    expect(requiresHitl("bash", ["(bash)"])).toBe(false); // literal parens in glob require literal parens in input
  });

  it("handles ** adjacent to text as segment-only (not cross-separator globstar)", () => {
    // ** adjacent to non-separator chars is just two * chars — segment-only.
    // It matches single-segment .env but NOT paths with separators.
    expect(requiresHitl(".env", ["**.env"])).toBe(true);
    expect(requiresHitl("/a/b/c.env", ["**.env"])).toBe(false);
    // Proper globstar form uses **/ to match across directories:
    expect(requiresHitl("/a/b/c.env", ["**/*.env"])).toBe(true);
  });

  it("handles trailing ** globstar", () => {
    expect(requiresHitl("/a/b", ["/a/**"])).toBe(true);
  });

  it("handles standalone ** globstar", () => {
    expect(requiresHitl("anything/at/all", ["**"])).toBe(true);
    expect(requiresHitl("single", ["**"])).toBe(true);
  });

  it("handles consecutive ** segments", () => {
    expect(requiresHitl("/a/b/c/d/file.txt", ["/a/**/b/**/file.txt"])).toBe(true);
  });
});
