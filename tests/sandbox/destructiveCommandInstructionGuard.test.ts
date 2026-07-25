import { describe, expect, it } from "vitest";

import { classify, isDestructiveRm, isDestructiveWindowsDelete } from '../../src/sandbox/destructiveCommandInstructionGuard.js';

// ---------------------------------------------------------------------------
// TDD: destructive command instruction guard (IDEA-F265-DESTRUCT-GUARD-01)
// ---------------------------------------------------------------------------

describe("isDestructiveRm — recursive force remove detection", () => {
  it("flags rm -rf as destructive", () => {
    expect(isDestructiveRm("rm -rf /tmp/foo")).toBe(true);
    expect(isDestructiveRm("rm -rf /")).toBe(true);
    expect(isDestructiveRm("rm -fr /tmp/foo")).toBe(true);
  });

  it("flags rm --recursive --force as destructive", () => {
    expect(isDestructiveRm("rm --recursive --force /tmp/foo")).toBe(true);
    expect(isDestructiveRm("rm --force --recursive /tmp/foo")).toBe(true);
  });

  it("flags rm with split flags", () => {
    expect(isDestructiveRm("rm -r -f /tmp/foo")).toBe(true);
    expect(isDestructiveRm("rm -f -r /tmp/foo")).toBe(true);
  });

  it("flags rm --dir --force (BSD long-form)", () => {
    expect(isDestructiveRm("rm --dir --force /tmp/foo")).toBe(true);
    expect(isDestructiveRm("rm --directory --force /tmp/foo")).toBe(true);
  });

  it("does NOT flag rm -r alone (recursive, no force)", () => {
    expect(isDestructiveRm("rm -r /tmp/foo")).toBe(false);
  });

  it("does NOT flag rm -f alone (force, no recursive)", () => {
    expect(isDestructiveRm("rm -f /tmp/file.txt")).toBe(false);
  });

  it("does NOT flag ordinary rm", () => {
    expect(isDestructiveRm("rm file.txt")).toBe(false);
    expect(isDestructiveRm("rm *.log")).toBe(false);
  });

  it("does NOT flag non-rm commands containing 'rm' as a substring", () => {
    expect(isDestructiveRm("echo confirming removal")).toBe(false);
    expect(isDestructiveRm("git rm file.txt")).toBe(false);
  });

  it("stops scanning flags at the first non-flag path argument", () => {
    // `-rf` here is a filename, not a flag (because /tmp/foo came first).
    expect(isDestructiveRm("rm /tmp/foo -rf")).toBe(false);
  });

  it("handles -- as end-of-options marker", () => {
    expect(isDestructiveRm("rm -- -rf /tmp/foo")).toBe(false);
    expect(isDestructiveRm("rm -rf -- /tmp/foo")).toBe(true); // -rf BEFORE --
  });
});

describe("isDestructiveWindowsDelete — Windows recursive delete detection", () => {
  it("flags del /s as destructive", () => {
    expect(isDestructiveWindowsDelete("del /s /q C:\\temp\\*")).toBe(true);
    expect(isDestructiveWindowsDelete("erase /s /q C:\\temp\\*")).toBe(true);
  });

  it("flags rmdir /s as destructive", () => {
    expect(isDestructiveWindowsDelete("rmdir /s /q C:\\temp")).toBe(true);
    expect(isDestructiveWindowsDelete("rd /s /q C:\\temp")).toBe(true);
  });

  it("flags Remove-Item -Recurse -Force", () => {
    expect(isDestructiveWindowsDelete("Remove-Item -Recurse -Force C:\\temp")).toBe(true);
    expect(isDestructiveWindowsDelete("Remove-Item -Force -Recurse C:\\temp")).toBe(true);
  });

  it("flags ri -r -fo (short aliases)", () => {
    expect(isDestructiveWindowsDelete("ri -r -fo C:\\temp")).toBe(true);
  });

  it("does NOT flag Remove-Item -Recurse alone (no force)", () => {
    expect(isDestructiveWindowsDelete("Remove-Item -Recurse C:\\temp")).toBe(false);
  });

  it("does NOT flag ordinary del (no /s)", () => {
    expect(isDestructiveWindowsDelete("del C:\\temp\\file.txt")).toBe(false);
  });
});

describe("classify — destructive command instruction guard", () => {
  // ── Destructive commands (force always_require) ──────────────────────

  it("rm -rf → destructive (force always_require)", () => {
    const result = classify("rm -rf /");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns).toContain("rm -rf (recursive force remove)");
  });

  it("rm --recursive --force → destructive", () => {
    const result = classify("rm --recursive --force /var/log");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns).toContain("rm -rf (recursive force remove)");
  });

  it("git push --force → destructive", () => {
    const result = classify("git push origin main --force");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns).toContain("git push --force");
  });

  it("git push -f → destructive", () => {
    const result = classify("git push origin main -f");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns).toContain("git push -f");
  });

  it("git reset --hard → destructive", () => {
    const result = classify("git reset --hard HEAD~1");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns).toContain("git reset --hard");
  });

  it("git clean -f → destructive", () => {
    expect(classify("git clean -fd").destructive).toBe(true);
    expect(classify("git clean -f").destructive).toBe(true);
  });

  it("mkfs → destructive", () => {
    const result = classify("mkfs.ext4 /dev/sda1");
    expect(result.destructive).toBe(true);
  });

  it("dd if= → destructive", () => {
    expect(classify("dd if=/dev/zero of=/dev/sda").destructive).toBe(true);
  });

  it("fork bomb → destructive", () => {
    expect(classify(":(){ :|:& };:").destructive).toBe(true);
  });

  it("shutdown → destructive", () => {
    expect(classify("shutdown -h now").destructive).toBe(true);
  });

  it("reboot → destructive", () => {
    expect(classify("reboot").destructive).toBe(true);
  });

  it("windows del /s → destructive", () => {
    const result = classify("del /s /q C:\\temp\\*");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns).toContain("windows recursive force delete (del /s, rmdir /s, Remove-Item -Recurse -Force)");
  });

  it("multiple destructive patterns are all reported", () => {
    // This command is contrived — it would never actually work, but it exercises multi-pattern.
    const result = classify("rm -rf / && git push --force origin main && shutdown -h now");
    expect(result.destructive).toBe(true);
    expect(result.matchedPatterns.length).toBeGreaterThanOrEqual(3);
  });

  // ── Safe commands ────────────────────────────────────────────────────

  it("echo hello → safe", () => {
    const result = classify("echo hello");
    expect(result.destructive).toBe(false);
    expect(result.reason).toBe("no destructive patterns matched");
    expect(result.matchedPatterns).toEqual([]);
  });

  it("ls → safe", () => {
    const result = classify("ls -la");
    expect(result.destructive).toBe(false);
  });

  it("npm test → safe", () => {
    const result = classify("npm test");
    expect(result.destructive).toBe(false);
  });

  it("git status → safe", () => {
    const result = classify("git status");
    expect(result.destructive).toBe(false);
  });

  it("git push without --force → safe", () => {
    expect(classify("git push origin main").destructive).toBe(false);
    expect(classify("git push --force-with-lease origin main").destructive).toBe(false);
  });

  it("cat file → safe", () => {
    const result = classify("cat package.json");
    expect(result.destructive).toBe(false);
  });

  it("empty command → safe", () => {
    const result = classify("");
    expect(result.destructive).toBe(false);
  });

  it("whitespace-only command → safe", () => {
    const result = classify("   ");
    expect(result.destructive).toBe(false);
  });

  it("mkdir → safe (creates, doesn't destroy)", () => {
    const result = classify("mkdir -p /tmp/newdir");
    expect(result.destructive).toBe(false);
  });

  // ── Reason field ─────────────────────────────────────────────────────

  it("reason field is populated for destructive commands", () => {
    const result = classify("rm -rf /tmp/foo");
    expect(result.reason).toContain("destructive command detected");
    expect(result.reason).toContain("rm -rf");
  });

  it("reason field is populated for safe commands", () => {
    const result = classify("echo safe");
    expect(result.reason).toBe("no destructive patterns matched");
  });
});
