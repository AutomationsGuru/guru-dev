import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn()
}));

import * as childProcess from "node:child_process";
import { suggest } from '../../src/tools/shellSuggestBuffer.js';

describe("shell suggest buffer", () => {
  it("returns the natural-language request as reviewable command text", () => {
    expect(suggest("  list all files including hidden  ")).toBe("list all files including hidden");
  });

  it("rejects an empty suggestion request", () => {
    expect(() => suggest("   ")).toThrow();
  });

  it("does not spawn or execute a shell", () => {
    expect(suggest("show disk usage")).toBe("show disk usage");
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it("preserves command whitespace inside the buffer", () => {
    expect(suggest('echo "two  spaces"')).toBe('echo "two  spaces"');
  });
});
